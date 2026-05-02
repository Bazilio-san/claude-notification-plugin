#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';

const QUEUE_FILE = path.join(os.homedir(), '.claude', '.task_queues.json');
const HISTORY_FILE = path.join(os.homedir(), '.claude', '.task_history.json');
const MAX_HISTORY = 50;

let idCounter = 0;

function generateId () {
  return `task_${Date.now()}_${(++idCounter).toString(36)}`;
}

/**
 * Per-workDir task queue with FIFO ordering and single-active-task lock.
 */
export class WorkQueue {
  constructor (logger, maxQueuePerWorkDir = 10, maxTotalTasks = 50) {
    this.logger = logger;
    this.maxQueuePerWorkDir = maxQueuePerWorkDir;
    this.maxTotalTasks = maxTotalTasks;
    this.queues = {}; // workDir → { project, branch, active, queue }
    this._load();
  }

  /**
   * Enqueue a task for a workDir. Returns the task object.
   * If no active task, marks it as ready to run immediately.
   */
  enqueue (workDir, project, branch, text, telegramMessageId, raw = false) {
    if (!this.queues[workDir]) {
      this.queues[workDir] = {
        project,
        branch: branch || 'main',
        active: null,
        queue: [],
      };
    }

    const entry = this.queues[workDir];
    const totalPending = this._countTotal();

    if (totalPending >= this.maxTotalTasks) {
      return { error: `Total task limit reached (${this.maxTotalTasks})` };
    }

    if (entry.queue.length >= this.maxQueuePerWorkDir) {
      return { error: `Queue limit reached for this workDir (${this.maxQueuePerWorkDir})` };
    }

    const task = {
      id: generateId(),
      text,
      project,
      branch: branch || 'main',
      telegramMessageId,
      raw: !!raw,
      addedAt: new Date().toISOString(),
    };

    if (!entry.active) {
      // Ready to run immediately
      entry.active = task;
      this._save();
      return { task, position: 0, immediate: true };
    }

    // Add to queue
    entry.queue.push(task);
    this._save();
    return {
      task,
      position: entry.queue.length,
      immediate: false,
      activeTask: entry.active,
    };
  }

  /**
   * Mark active task as started (update PID and startedAt).
   */
  markStarted (workDir, pid) {
    const entry = this.queues[workDir];
    if (entry?.active) {
      entry.active.pid = pid;
      entry.active.startedAt = new Date().toISOString();
      this._save();
    }
  }

  /**
   * Complete the active task. Returns next task if available, or null.
   */
  onTaskComplete (workDir, result) {
    const entry = this.queues[workDir];
    if (!entry) {
      return null;
    }

    // Record in history
    if (entry.active) {
      this._addHistory({
        ...entry.active,
        project: entry.project,
        branch: entry.branch,
        workDir,
        completedAt: new Date().toISOString(),
        result: result ? result.slice(0, 500) : '',
      });
    }

    // Get next task
    if (entry.queue.length > 0) {
      entry.active = entry.queue.shift();
      this._save();
      return entry.active;
    }

    entry.active = null;
    this._save();
    return null;
  }

  /**
   * Cancel the active task in a workDir. Returns next task if available.
   */
  cancelActive (workDir) {
    const entry = this.queues[workDir];
    if (!entry?.active) {
      return null;
    }

    this._addHistory({
      ...entry.active,
      project: entry.project,
      branch: entry.branch,
      workDir,
      completedAt: new Date().toISOString(),
      result: 'CANCELLED',
    });

    if (entry.queue.length > 0) {
      entry.active = entry.queue.shift();
      this._save();
      return entry.active;
    }

    entry.active = null;
    this._save();
    return null;
  }

  /**
   * Remove a task from the queue by index (1-based).
   */
  removeFromQueue (workDir, index) {
    const entry = this.queues[workDir];
    if (!entry) {
      return null;
    }
    const idx = index - 1;
    if (idx < 0 || idx >= entry.queue.length) {
      return null;
    }
    const removed = entry.queue.splice(idx, 1)[0];
    this._save();
    return removed;
  }

  /**
   * Clear all queued (non-active) tasks for a workDir.
   */
  clearQueue (workDir) {
    const entry = this.queues[workDir];
    if (!entry) {
      return 0;
    }
    const count = entry.queue.length;
    entry.queue = [];
    this._save();
    return count;
  }

  /**
   * Get status for a project (all workDirs).
   */
  getProjectStatus (projectAlias) {
    const results = [];
    for (const [workDir, entry] of Object.entries(this.queues)) {
      if (entry.project === projectAlias) {
        results.push({
          workDir,
          branch: entry.branch,
          active: entry.active,
          queueLength: entry.queue.length,
          queue: entry.queue,
        });
      }
    }
    return results;
  }

  /**
   * Get status for all projects.
   */
  getAllStatus () {
    const results = {};
    for (const [workDir, entry] of Object.entries(this.queues)) {
      if (!results[entry.project]) {
        results[entry.project] = [];
      }
      results[entry.project].push({
        workDir,
        branch: entry.branch,
        active: entry.active,
        queueLength: entry.queue.length,
      });
    }
    return results;
  }

  /**
   * Get recent task history.
   */
  getHistory (limit = 10) {
    return this._loadHistory().slice(-limit);
  }

  /**
   * Watchdog: clean up stale active tasks (dead PIDs, expired timeouts).
   */
  watchdog (taskTimeout) {
    const now = Date.now();
    const recovered = [];
    for (const [workDir, entry] of Object.entries(this.queues)) {
      if (!entry.active) {
        continue;
      }
      const startedAt = entry.active.startedAt ? new Date(entry.active.startedAt).getTime() : 0;
      const isStale = startedAt > 0 && (now - startedAt) > taskTimeout;

      if (isStale) {
        this.logger.warn(`Watchdog: stale task "${entry.active.id}" in ${workDir}`);
        const next = this.onTaskComplete(workDir, 'STALE (watchdog cleanup)');
        recovered.push({ workDir, next });
      }
    }
    return recovered;
  }

  _countTotal () {
    let count = 0;
    for (const entry of Object.values(this.queues)) {
      if (entry.active) {
        count++;
      }
      count += entry.queue.length;
    }
    return count;
  }

  _load () {
    if (!fs.existsSync(QUEUE_FILE)) {
      return;
    }
    try {
      this.queues = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    } catch (err) {
      // Move aside corrupt file (truncated by crash mid-write, ENOSPC, etc.)
      // so the next start succeeds instead of looping on a parse error.
      const corrupt = `${QUEUE_FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(QUEUE_FILE, corrupt);
        this.logger.error(`Queue file corrupt, moved to ${corrupt}: ${err.message}`);
      } catch (renameErr) {
        this.logger.error(`Queue file corrupt and rename failed: ${err.message} / ${renameErr.message}`);
      }
      this.queues = {};
    }
  }

  _save () {
    try {
      const dir = path.dirname(QUEUE_FILE);
      fs.mkdirSync(dir, { recursive: true });
      // Atomic write: tmp + rename. Crash mid-write leaves the tmp orphan,
      // not a half-written QUEUE_FILE.
      const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.queues, null, 2));
      fs.renameSync(tmp, QUEUE_FILE);
    } catch (err) {
      this.logger.error(`Failed to save queue file: ${err.message}`);
    }
  }

  _addHistory (entry) {
    const history = this._loadHistory();
    history.push(entry);
    while (history.length > MAX_HISTORY) {
      history.shift();
    }
    try {
      const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
      fs.renameSync(tmp, HISTORY_FILE);
    } catch {
      // ignore
    }
  }

  _loadHistory () {
    if (!fs.existsSync(HISTORY_FILE)) {
      return [];
    }
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    } catch (err) {
      const corrupt = `${HISTORY_FILE}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(HISTORY_FILE, corrupt);
        this.logger.error(`History file corrupt, moved to ${corrupt}: ${err.message}`);
      } catch {
        // ignore
      }
      return [];
    }
  }
}
