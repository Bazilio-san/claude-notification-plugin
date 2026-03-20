#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PTY_SIGNAL_DIR } from '../bin/constants.js';

const DEFAULT_TIMEOUT = 600_000; // 10 minutes

/**
 * PTY-based runner for Claude Code.
 * Uses node-pty to spawn an interactive Claude session and
 * receives completion signals via marker files written by the notifier hook.
 */
export class PtyRunner extends EventEmitter {
  constructor (logger, timeout, taskLogger) {
    super();
    this.logger = logger;
    this.timeout = timeout || DEFAULT_TIMEOUT;
    this.taskLogger = taskLogger || null;
    // workDir -> { pty, state, currentTask, sessionId, workDir, _pendingId, _buffer }
    this.sessions = new Map();
    this.pendingMarkers = new Map(); // pendingId -> resolve callback
    this._pty = null; // lazy-loaded node-pty module
    this._startMarkerWatcher();
  }

  /**
   * Lazily load node-pty module.
   */
  async _loadPty () {
    if (!this._pty) {
      this._pty = await import('node-pty');
    }
    return this._pty;
  }

  /**
   * Start watching the signal directory for marker files.
   */
  _startMarkerWatcher () {
    try {
      fs.mkdirSync(PTY_SIGNAL_DIR, { recursive: true });
    } catch {
      // ignore
    }

    // Clean up stale marker files on startup
    try {
      const files = fs.readdirSync(PTY_SIGNAL_DIR);
      for (const f of files) {
        if (f.endsWith('.json')) {
          try {
            fs.unlinkSync(path.join(PTY_SIGNAL_DIR, f));
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    // Use polling-based watcher for cross-platform reliability
    this._pollInterval = setInterval(() => this._checkMarkerFiles(), 500);
  }

  /**
   * Check for new marker files in the signal directory.
   */
  _checkMarkerFiles () {
    if (this.pendingMarkers.size === 0) {
      return;
    }

    let files;
    try {
      files = fs.readdirSync(PTY_SIGNAL_DIR);
    } catch {
      return;
    }

    for (const f of files) {
      if (!f.endsWith('.json')) {
        continue;
      }

      const filePath = path.join(PTY_SIGNAL_DIR, f);
      let marker;
      try {
        marker = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue;
      }

      // Try to match by cwd (primary matching for PTY runner)
      const cwd = marker.cwd;
      if (cwd) {
        for (const [pid, resolve] of this.pendingMarkers) {
          const session = this._findSessionByPendingId(pid);
          if (session && this._normalizePath(session.workDir) === this._normalizePath(cwd)) {
            this.pendingMarkers.delete(pid);
            try {
              fs.unlinkSync(filePath);
            } catch {
              // ignore
            }
            resolve(marker);
            break;
          }
        }
      }
    }
  }

  _normalizePath (p) {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  _findSessionByPendingId (pendingId) {
    for (const [, session] of this.sessions) {
      if (session._pendingId === pendingId) {
        return session;
      }
    }
    return null;
  }

  /**
   * Wait for a marker file for the given pending ID.
   */
  _waitForMarker (pendingId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMarkers.delete(pendingId);
        reject(new Error('Marker timeout'));
      }, timeoutMs);

      this.pendingMarkers.set(pendingId, (marker) => {
        clearTimeout(timer);
        resolve(marker);
      });
    });
  }

  /**
   * Run a task in a specific workDir.
   * Returns the task object immediately, emits events on completion.
   * Returns the task object immediately, emits events on completion.
   */
  run (workDir, task, claudeArgs = [], continueSession = false) {
    if (this.sessions.has(workDir) && this.sessions.get(workDir).state === 'busy') {
      throw new Error(`Already running a task in ${workDir}`);
    }

    if (this.taskLogger) {
      this.taskLogger.logQuestion(task.project || 'unknown', task.branch || 'main', workDir, task.text);
    }

    task.startedAt = new Date().toISOString();
    task.continueSession = continueSession;

    // Mark as busy immediately with a placeholder session
    const existingSession = this.sessions.get(workDir);
    if (existingSession && existingSession.state === 'idle' && continueSession) {
      // Reuse existing PTY session
      this._sendTask(workDir, existingSession, task);
    } else {
      // Need a new PTY session — create async
      if (existingSession) {
        this._destroyPty(workDir);
      }
      // Create a placeholder to prevent double-starts
      this.sessions.set(workDir, { state: 'busy', currentTask: task, workDir });
      this._createAndSendTask(workDir, task, claudeArgs);
    }

    return task;
  }

  /**
   * Create PTY session and send task (async, fire-and-forget).
   */
  _createAndSendTask (workDir, task, claudeArgs) {
    this._createPtySession(workDir, claudeArgs).then((session) => {
      this.sessions.set(workDir, session);
      this._sendTask(workDir, session, task);
    }).catch((err) => {
      this.sessions.delete(workDir);
      const errorMsg = `Failed to create PTY session: ${err.message}`;
      this.logger.error(errorMsg);
      if (this.taskLogger) {
        this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', errorMsg, 1);
      }
      this.emit('error', workDir, task, errorMsg);
    });
  }

  /**
   * Send a task to an existing PTY session and wait for completion.
   */
  _sendTask (workDir, session, task) {
    const pendingId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    session.state = 'busy';
    session.currentTask = task;
    session._pendingId = pendingId;

    // Set up marker wait + timeout
    const markerPromise = this._waitForMarker(pendingId, this.timeout);

    // Send the task text to the PTY
    session.pty.write(task.text + '\r');
    this.logger.info(`PTY task sent to ${workDir}: ${task.text.slice(0, 100)}`);

    // Handle completion asynchronously
    markerPromise.then((marker) => {
      session.state = 'idle';
      session.currentTask = null;
      session.sessionId = marker.sessionId;

      const result = {
        text: marker.lastAssistantMessage || '',
        sessionId: marker.sessionId || null,
        cost: marker.cost || 0,
        numTurns: marker.numTurns || 0,
        durationMs: marker.durationMs || 0,
        contextWindow: marker.contextWindow || 0,
        totalTokens: marker.totalTokens || 0,
        isError: false,
      };

      this.logger.info(`PTY task completed in ${workDir} (session: ${result.sessionId || 'unknown'})`);
      if (this.taskLogger) {
        this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', result.text, 0);
      }
      this.emit('complete', workDir, task, result);
    }).catch((err) => {
      session.state = 'idle';
      session.currentTask = null;

      if (err.message === 'Marker timeout') {
        this.logger.warn(`PTY task timed out in ${workDir}`);
        this._destroyPty(workDir);
        this.emit('timeout', workDir, task);
      } else {
        this.logger.error(`PTY task error in ${workDir}: ${err.message}`);
        if (this.taskLogger) {
          this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', err.message, 1);
        }
        this.emit('error', workDir, task, err.message);
      }
    });
  }

  /**
   * Create a new PTY session for a workDir.
   */
  async _createPtySession (workDir, claudeArgs = []) {
    const pty = await this._loadPty();
    const spawn = pty.spawn || pty.default?.spawn;

    if (!spawn) {
      throw new Error('node-pty spawn function not found');
    }

    // Filter out pipe-mode-specific args
    const args = claudeArgs.filter(a => a !== '-p' && a !== '--output-format' && a !== 'json');

    this.logger.info(`Creating PTY session in ${workDir} with args: ${JSON.stringify(args)}`);

    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/bash';
    const shellArgs = process.platform === 'win32'
      ? ['/c', 'claude', ...args]
      : ['-c', ['claude', ...args].join(' ')];

    const ptyProcess = spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: workDir,
      env: {
        ...process.env,
        CLAUDE_NOTIFY_FROM_LISTENER: '1',
        TERM: 'xterm-256color',
      },
    });

    const session = {
      pty: ptyProcess,
      state: 'starting',
      currentTask: null,
      sessionId: null,
      workDir,
      _pendingId: null,
      _buffer: '',
    };

    ptyProcess.onData((data) => {
      session._buffer += data;
      // Keep buffer reasonable size
      if (session._buffer.length > 50000) {
        session._buffer = session._buffer.slice(-25000);
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.logger.info(`PTY exited in ${workDir} with code ${exitCode}`);
      const currentSession = this.sessions.get(workDir);
      if (currentSession === session) {
        if (session._pendingId && this.pendingMarkers.has(session._pendingId)) {
          this.pendingMarkers.delete(session._pendingId);
          if (session.currentTask) {
            const task = session.currentTask;
            session.state = 'dead';
            session.currentTask = null;
            this.sessions.delete(workDir);
            const errorMsg = `PTY process exited unexpectedly (code ${exitCode})`;
            this.logger.error(errorMsg);
            if (this.taskLogger) {
              this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', errorMsg, exitCode || 1);
            }
            this.emit('error', workDir, task, errorMsg);
            return;
          }
        }
        this.sessions.delete(workDir);
      }
    });

    // Wait for Claude to start up (stabilize output)
    await this._waitForReady(session, 15000);

    session.state = 'idle';
    this.logger.info(`PTY session ready in ${workDir}`);
    return session;
  }

  /**
   * Wait for PTY output to stabilize (Claude has loaded).
   */
  _waitForReady (session, timeoutMs) {
    return new Promise((resolve) => {
      let lastLength = 0;
      let stableCount = 0;
      const checkInterval = 500;

      const timer = setInterval(() => {
        const currentLength = session._buffer.length;
        if (currentLength > 0 && currentLength === lastLength) {
          stableCount++;
          if (stableCount >= 3) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve();
          }
        } else {
          stableCount = 0;
        }
        lastLength = currentLength;
      }, checkInterval);

      const timeout = setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, timeoutMs);
    });
  }

  /**
   * Destroy PTY process for a workDir.
   */
  _destroyPty (workDir) {
    const session = this.sessions.get(workDir);
    if (!session) {
      return;
    }

    if (session._pendingId && this.pendingMarkers.has(session._pendingId)) {
      this.pendingMarkers.delete(session._pendingId);
    }

    try {
      if (session.pty) {
        session.pty.kill();
      }
    } catch {
      // already dead
    }
    this.sessions.delete(workDir);
  }

  /**
   * Cancel the active task in a workDir.
   */
  cancel (workDir) {
    const session = this.sessions.get(workDir);
    if (!session) {
      return;
    }

    try {
      if (session.pty) {
        session.pty.write('\x03');
      }
    } catch {
      // ignore
    }

    if (session._pendingId && this.pendingMarkers.has(session._pendingId)) {
      this.pendingMarkers.delete(session._pendingId);
    }

    this._destroyPty(workDir);
  }

  /**
   * Check if a task is running in a workDir.
   */
  isRunning (workDir) {
    const session = this.sessions.get(workDir);
    return session?.state === 'busy';
  }

  /**
   * Get active task info for a workDir.
   */
  getActive (workDir) {
    const session = this.sessions.get(workDir);
    return session?.currentTask || null;
  }

  /**
   * Cancel all active tasks (for graceful shutdown).
   */
  cancelAll () {
    for (const workDir of [...this.sessions.keys()]) {
      this._destroyPty(workDir);
    }
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }
}
