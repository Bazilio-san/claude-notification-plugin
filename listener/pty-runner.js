#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { PTY_SIGNAL_DIR } from '../bin/constants.js';
import { cleanPtyOutput } from './telegram-poller.js';

const DEFAULT_TIMEOUT = 600_000; // 10 minutes
// Built-in slash-commands (forwarded via %cmd) rarely emit a Stop hook event,
// so we fall back to "done" after this much buffer inactivity.
const RAW_INACTIVITY_MS = 8_000;

/**
 * PTY-based runner for Claude Code.
 * Uses node-pty to spawn an interactive Claude session and
 * receives completion signals via marker files written by the notifier hook.
 */
export class PtyRunner extends EventEmitter {
  constructor (logger, timeout, taskLogger, ptyLogDir) {
    super();
    this.logger = logger;
    this.timeout = timeout || DEFAULT_TIMEOUT;
    this.taskLogger = taskLogger || null;
    this.ptyLogDir = ptyLogDir || null;
    // workDir -> { pty, state, currentTask, sessionId, workDir, _pendingId, _buffer, _logStream }
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
   * Handles typed signals: stop (default), error, ready, activity, compact.
   */
  _checkMarkerFiles () {
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

      const cwd = marker.cwd;
      if (!cwd) {
        continue;
      }

      const type = marker.type || 'stop';

      if (type === 'stop') {
        // Completion signal — resolve pending marker
        if (this.pendingMarkers.size === 0) {
          continue;
        }
        for (const [pid, resolve] of this.pendingMarkers) {
          const session = this._findSessionByPendingId(pid);
          if (session && this._normalizePath(session.workDir) === this._normalizePath(cwd)) {
            session._lastActivityTime = Date.now();
            this.pendingMarkers.delete(pid);
            this._unlinkSafe(filePath);
            resolve(marker);
            break;
          }
        }
      } else if (type === 'error') {
        // StopFailure — emit error, abort task
        this._unlinkSafe(filePath);
        for (const [workDir, session] of this.sessions) {
          if (session.state === 'busy' && this._normalizePath(session.workDir) === this._normalizePath(cwd)) {
            if (session._pendingId && this.pendingMarkers.has(session._pendingId)) {
              this.pendingMarkers.delete(session._pendingId);
            }
            const task = session.currentTask;
            session.state = 'idle';
            session.currentTask = null;
            this._destroyPty(workDir);
            const errorMsg = `API error: ${marker.error}${marker.errorDetails ? ' — ' + marker.errorDetails : ''}`;
            this.logger.error(`Hook signal: ${errorMsg} in ${workDir}`);
            if (this.taskLogger) {
              this.taskLogger.logAnswer(task?.project || 'unknown', task?.branch || 'main', errorMsg, 1);
            }
            this.emit('error', workDir, task, errorMsg);
            break;
          }
        }
      } else if (type === 'ready') {
        // SessionStart — emit ready event, capture sessionId from filename
        this._unlinkSafe(filePath);
        const signalSessionId = f.startsWith('rdy_') ? f.slice(4, -5) : null;
        for (const [workDir, session] of this.sessions) {
          if (this._normalizePath(session.workDir) === this._normalizePath(cwd)) {
            session._lastActivityTime = Date.now();
            session._model = marker.model || '';
            if (signalSessionId && signalSessionId !== 'unknown') {
              session.sessionId = signalSessionId;
            }
            this.emit('ready', workDir, marker);
            break;
          }
        }
      } else if (type === 'activity') {
        // PostToolUse — update activity data (don't delete, gets overwritten)
        for (const [, session] of this.sessions) {
          if (this._normalizePath(session.workDir) === this._normalizePath(cwd)) {
            session._lastActivityTime = Date.now();
            session._lastActivity = {
              toolName: marker.toolName,
              toolInput: marker.toolInput,
              timestamp: marker.timestamp,
            };
            break;
          }
        }
      } else if (type === 'compact') {
        // PostCompact — update compaction info
        this._unlinkSafe(filePath);
        for (const [workDir, session] of this.sessions) {
          if (this._normalizePath(session.workDir) === this._normalizePath(cwd)) {
            session._lastActivityTime = Date.now();
            session._lastCompact = {
              summary: marker.summary,
              trigger: marker.trigger,
              timestamp: marker.timestamp,
            };
            this.emit('compact', workDir, marker);
            break;
          }
        }
      }
    }
  }

  _unlinkSafe (filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
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
  /**
   * Wait for a marker file with inactivity-based timeout.
   * Timer resets on any PTY output or hook signal activity.
   */
  _waitForMarker (pendingId, inactivityMs, session) {
    return new Promise((resolve, reject) => {
      if (session) {
        session._lastActivityTime = Date.now();
      }

      const CHECK_INTERVAL = 5000;
      const checker = setInterval(() => {
        const lastActivity = session?._lastActivityTime || 0;
        if (lastActivity > 0 && Date.now() - lastActivity > inactivityMs) {
          clearInterval(checker);
          this.pendingMarkers.delete(pendingId);
          reject(new Error('Marker timeout'));
        }
      }, CHECK_INTERVAL);

      this.pendingMarkers.set(pendingId, (marker) => {
        clearInterval(checker);
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

  _openPtyLog (session, task) {
    if (session._logStream) {
      session._logStream.end();
      session._logStream = null;
    }
    if (!this.ptyLogDir) {
      return;
    }
    try {
      const project = task.project || 'unknown';
      const branch = (task.branch || 'main').replace(/[/\\:*?"<>|]/g, '_');
      const logFile = path.join(this.ptyLogDir, `${project}_${branch}_pty.log`);
      session._logStream = fs.createWriteStream(logFile, { flags: 'w' });
      session._logStream.on('error', () => {
        session._logStream = null;
      });
    } catch {
      // ignore — logging is best-effort
    }
  }

  /**
   * Send a task to an existing PTY session and wait for completion.
   */
  _sendTask (workDir, session, task) {
    const pendingId = `pty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    session.state = 'busy';
    session.currentTask = task;
    session._pendingId = pendingId;
    session._buffer = '';
    this._openPtyLog(session, task);

    // Set up marker wait + inactivity timeout. Raw slash-commands use a much
    // shorter window because they typically don't trigger an agent turn and
    // therefore never produce a Stop signal.
    const inactivityMs = task.raw ? RAW_INACTIVITY_MS : this.timeout;
    const markerPromise = this._waitForMarker(pendingId, inactivityMs, session);

    // Send the task text to the PTY.
    // Bracketed paste mode (\x1b[200~...\x1b[201~) causes Claude to hang in ConPTY,
    // so we send raw text. For multiline messages, use backslash + Enter as line
    // continuation (Claude Code interprets \ + Enter as a newline within the prompt),
    // with delays between lines so Claude can process each one.
    const lines = task.text.split(/\r?\n/);
    const writeLines = async () => {
      if (lines.length === 1) {
        session.pty.write(`${lines[0]}\r`);
      } else {
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) {
            await new Promise(r => setTimeout(r, 300));
          }
          if (i < lines.length - 1) {
            session.pty.write(`${lines[i]}\\\r`);
          } else {
            session.pty.write(`${lines[i]}\r`);
          }
        }
        // Extra Enter to submit the multiline prompt
        await new Promise(r => setTimeout(r, 300));
        session.pty.write('\r');
      }
    };
    writeLines();
    this.logger.info(`PTY task sent to ${workDir}: ${task.text.slice(0, 100)}`);

    // Error detection is now handled by the StopFailure hook signal,
    // which writes an error signal file processed by _checkMarkerFiles.

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
        if (task.raw) {
          // Slash commands (e.g. /clear, /cost) usually don't emit a Stop hook.
          // Treat inactivity as successful completion and keep the PTY alive.
          const cleaned = cleanPtyOutput(session._buffer || '').trim();
          const tail = cleaned.length > 2000 ? cleaned.slice(-2000) : cleaned;
          const result = {
            text: tail,
            sessionId: session.sessionId || null,
            cost: 0,
            numTurns: 0,
            durationMs: 0,
            contextWindow: 0,
            totalTokens: 0,
            isError: false,
            raw: true,
          };
          this.logger.info(`PTY raw command finished (no Stop signal) in ${workDir}`);
          if (this.taskLogger) {
            this.taskLogger.logAnswer(task.project || 'unknown', task.branch || 'main', tail, 0);
          }
          this.emit('complete', workDir, task, result);
          return;
        }
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

    // Ensure --permission-mode is set to prevent interactive permission prompts.
    // Use bypassPermissions as default — "auto" is not available on all plans/providers.
    if (!args.includes('--permission-mode') && !args.includes('--dangerously-skip-permissions')) {
      args.push('--permission-mode', 'bypassPermissions');
    }

    // Reduce PTY output noise: disable animations, progress bar, tips
    if (!args.includes('--settings')) {
      args.push('--settings', JSON.stringify({
        // prefersReducedMotion: true,
        // outputStyle: 'plain',
        terminalProgressBarEnabled: false,
        spinnerTipsEnabled: false,
        showTurnDuration: false,
      }));
    }

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

    // Permission auto-approval is now handled by the PermissionRequest hook
    // (returns auto-approve JSON when CLAUDE_NOTIFY_FROM_LISTENER=1).

    ptyProcess.onData((data) => {
      session._buffer += data;
      session._lastActivityTime = Date.now();
      // Keep buffer reasonable size
      if (session._buffer.length > 50000) {
        session._buffer = session._buffer.slice(-25000);
      }
      if (session._logStream) {
        session._logStream.write(data);
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
   * Automatically answers the workspace trust prompt if it appears.
   */
  _waitForReady (session, timeoutMs) {
    return new Promise((resolve) => {
      let lastLength = 0;
      let stableCount = 0;
      let trustAnswered = false;
      const checkInterval = 500;

      const timer = setInterval(() => {
        // Detect and auto-answer workspace trust prompt
        if (!trustAnswered) {
          const buf = (session._buffer || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\s/g, '');
          if (buf.includes('trustthisfolder') || buf.includes('Yesiproceed')) {
            trustAnswered = true;
            this.logger.info('Auto-answering workspace trust prompt');
            session.pty.write('\r');
          }
        }

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

    if (session._logStream) {
      session._logStream.end();
      session._logStream = null;
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
   * Check if a PTY session exists for a workDir (busy or idle).
   * Used to decide whether to kill before spawning a fresh session for --resume.
   */
  isPtyAlive (workDir) {
    return this.sessions.has(workDir);
  }

  /**
   * Get active task info for a workDir.
   */
  getActive (workDir) {
    const session = this.sessions.get(workDir);
    return session?.currentTask || null;
  }

  /**
   * Get the raw PTY buffer for a workDir.
   */
  getBuffer (workDir) {
    const session = this.sessions.get(workDir);
    return session?._buffer || '';
  }

  /**
   * Get Claude session ID for a workDir (captured from SessionStart hook signal).
   */
  getSessionId (workDir) {
    const session = this.sessions.get(workDir);
    return session?.sessionId || null;
  }

  /**
   * Get last tool activity for a workDir (from PostToolUse hook signals).
   */
  getActivity (workDir) {
    const session = this.sessions.get(workDir);
    return session?._lastActivity || null;
  }

  /**
   * Clean up activity signal file for a workDir.
   */
  cleanActivitySignal (workDir) {
    const session = this.sessions.get(workDir);
    if (session) {
      session._lastActivity = null;
    }
    // Also try to delete any activity files matching this workDir
    try {
      const files = fs.readdirSync(PTY_SIGNAL_DIR);
      for (const f of files) {
        if (!f.startsWith('act_') || !f.endsWith('.json')) {
          continue;
        }
        const filePath = path.join(PTY_SIGNAL_DIR, f);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.cwd && this._normalizePath(data.cwd) === this._normalizePath(workDir)) {
            fs.unlinkSync(filePath);
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Get diagnostic info about a PTY session.
   */
  getSessionInfo (workDir) {
    const session = this.sessions.get(workDir);
    if (!session) {
      return null;
    }
    return {
      state: session.state,
      bufferSize: session._buffer?.length || 0,
      hasLogStream: !!session._logStream,
      taskText: session.currentTask?.text || null,
      startedAt: session.currentTask?.startedAt || null,
      sessionId: session.sessionId || null,
      pendingId: session._pendingId || null,
    };
  }

  /**
   * Get diagnostic info for all sessions.
   */
  getAllSessionInfo () {
    const result = {};
    for (const [workDir, session] of this.sessions) {
      result[workDir] = {
        state: session.state,
        bufferSize: session._buffer?.length || 0,
        hasLogStream: !!session._logStream,
        taskText: session.currentTask?.text || null,
        startedAt: session.currentTask?.startedAt || null,
      };
    }
    return result;
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
