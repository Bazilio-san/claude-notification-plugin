#!/usr/bin/env node

import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const DEFAULT_TIMEOUT = 600_000; // 10 minutes

/**
 * Parse JSON output from claude --output-format json.
 * Returns structured result or fallback with raw text.
 */
function parseClaudeOutput (raw) {
  try {
    const data = JSON.parse(raw);
    const modelUsage = data.modelUsage || {};
    const model = Object.keys(modelUsage)[0];
    const mu = model ? modelUsage[model] : {};
    const totalTokens = (mu.inputTokens || 0)
      + (mu.cacheReadInputTokens || 0)
      + (mu.cacheCreationInputTokens || 0)
      + (mu.outputTokens || 0);
    return {
      text: data.result || '',
      sessionId: data.session_id || null,
      cost: data.total_cost_usd || 0,
      numTurns: data.num_turns || 0,
      durationMs: data.duration_ms || 0,
      contextWindow: mu.contextWindow || 0,
      totalTokens,
      isError: !!data.is_error,
    };
  } catch {
    return { text: raw.trim(), sessionId: null };
  }
}

/**
 * Runs claude CLI tasks and emits events on completion.
 */
export class TaskRunner extends EventEmitter {
  constructor (logger, timeout, taskLogger) {
    super();
    this.logger = logger;
    this.timeout = timeout || DEFAULT_TIMEOUT;
    this.taskLogger = taskLogger || null;
    this.activeProcesses = new Map(); // workDir -> { child, timer, task }
  }

  /**
   * Run a task in a specific workDir.
   * @param {string} workDir - Working directory
   * @param {object} task - Task object { id, text, telegramMessageId, ... }
   * @param {string[]} claudeArgs - Extra CLI args
   * @param {boolean} continueSession - Add --continue flag
   * @returns {object} task with pid
   */
  run (workDir, task, claudeArgs = [], continueSession = false) {
    if (this.activeProcesses.has(workDir)) {
      throw new Error(`Already running a task in ${workDir}`);
    }

    if (this.taskLogger) {
      this.taskLogger.logQuestion(task.project || 'unknown', task.branch || 'main', workDir, task.text);
    }

    const args = ['-p', task.text, '--output-format', 'json', ...claudeArgs];
    if (continueSession) {
      args.push('--continue');
    }

    const cmdLine = ['claude', ...args].map(a => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    this.logger.info(`cwd: ${workDir}\n  cmd: ${cmdLine}`);

    const child = spawn('claude', args, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      env: { ...process.env, CLAUDE_NOTIFY_FROM_LISTENER: '1' },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      this.logger.warn(`Task "${task.id}" timed out in ${workDir}`);
      this._killProcess(workDir);
      this.emit('timeout', workDir, task);
    }, this.timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      this.activeProcesses.delete(workDir);

      if (code === null) {
        // Process was killed (timeout or cancel)
        return;
      }

      if (code === 0) {
        const result = parseClaudeOutput(stdout);
        this.logger.info(`Task "${task.id}" completed in ${workDir} (session: ${result.sessionId || 'unknown'})`);
        if (this.taskLogger) {
          this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', result.text, 0);
        }
        this.emit('complete', workDir, task, result);
      } else {
        const errorMsg = stderr.trim() || `Process exited with code ${code}`;
        this.logger.error(`Task "${task.id}" failed in ${workDir}: ${errorMsg}`);
        if (this.taskLogger) {
          this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', errorMsg, code);
        }
        this.emit('error', workDir, task, errorMsg);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      this.activeProcesses.delete(workDir);
      this.logger.error(`Task "${task.id}" spawn error: ${err.message}`);
      this.emit('error', workDir, task, err.message);
    });

    task.pid = child.pid;
    task.startedAt = new Date().toISOString();
    task.continueSession = continueSession;
    this.activeProcesses.set(workDir, { child, timer, task });

    return task;
  }

  /**
   * Cancel the active task in a workDir.
   */
  cancel (workDir) {
    this._killProcess(workDir);
  }

  /**
   * Check if a task is running in a workDir.
   */
  isRunning (workDir) {
    return this.activeProcesses.has(workDir);
  }

  /**
   * Get active task info for a workDir.
   */
  getActive (workDir) {
    const entry = this.activeProcesses.get(workDir);
    return entry?.task || null;
  }

  /**
   * Cancel all active tasks (for graceful shutdown).
   */
  cancelAll () {
    for (const workDir of this.activeProcesses.keys()) {
      this._killProcess(workDir);
    }
  }

  _killProcess (workDir) {
    const entry = this.activeProcesses.get(workDir);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        entry.child.kill('SIGTERM');
        setTimeout(() => {
          try {
            entry.child.kill('SIGKILL');
          } catch {
            // already dead
          }
        }, 3000);
      }
    } catch {
      // process already dead
    }
    this.activeProcesses.delete(workDir);
  }
}
