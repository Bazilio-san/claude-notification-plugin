#!/usr/bin/env node
// noinspection UnnecessaryLocalVariableJS

import fs from 'fs';
import path from 'path';
import process from 'process';
import { createLogger } from './logger.js';
import { createTaskLogger } from './task-logger.js';
import { TelegramPoller, escapeHtml, cleanPtyOutput } from './telegram-poller.js';
import { WorkQueue } from './work-queue.js';
import { PtyRunner } from './pty-runner.js';
import { WorktreeManager } from './worktree-manager.js';
import { parseMessage, parseTarget } from './message-parser.js';
import {
  CLAUDE_DIR,
  CONFIG_PATH,
  LISTENER_LOG_FILENAME,
  MAX_SEEN_ENTRIES,
  SEEN_PROJECTS_PATH,
  getDefaultProject,
  saveConfig,
  normalizeForCompare,
  loadSeenProjects,
} from '../bin/constants.js';
import { JsonlReader, resolveJsonlPath, resolveJsonlByMtime, cwdToProjectDir } from './jsonl-reader.js';
import { listSessions } from './session-list.js';
import { findLocking, killPid } from './file-locks.js';

// ----------------------
// CRASH PROTECTION
// ----------------------

process.on('uncaughtException', (err) => {
  const msg = `[UNCAUGHT] ${err.message}`;
  try {
    console.error(msg, err.stack);
  } catch {
    // ignore
  }
  // Don't exit for known node-pty cleanup errors
  if (err.message?.includes('AttachConsole failed')) {
    return;
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ----------------------
// CONFIG
// ----------------------

const DEFAULT_LOG_DIR = CLAUDE_DIR;

function loadConfig () {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load config from ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
}

// ----------------------
// MAIN DAEMON
// ----------------------

const config = loadConfig();
const listenerLogDir = config.listener?.logDir || DEFAULT_LOG_DIR;
fs.mkdirSync(listenerLogDir, { recursive: true });
const logger = createLogger(path.join(listenerLogDir, LISTENER_LOG_FILENAME));

// Validate required fields
const token = process.env.CLAUDE_NOTIFY_TELEGRAM_TOKEN || config.telegramToken || config.telegram?.token;
const chatId = process.env.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID || config.telegramChatId || config.telegram?.chatId;

if (!token || !chatId) {
  logger.error('Missing telegramToken or telegramChatId in config');
  console.error('Missing telegramToken or telegramChatId in config');
  process.exit(1);
}

if (!config.listener?.projects || Object.keys(config.listener.projects).length === 0) {
  logger.error('No projects defined in config.listener.projects');
  console.error('No projects defined in config.listener.projects. Run "claude-notify listener setup" to configure.');
  process.exit(1);
}

// Validate project paths — skip projects with missing/invalid directories
const validatedProjects = {};
for (const [alias, proj] of Object.entries(config.listener.projects)) {
  const projPath = typeof proj === 'string' ? proj : proj?.path;
  if (!projPath) {
    logger.warn(`Project "${alias}": no path configured, skipping`);
    console.error(`\u26a0 Project "${alias}": no path configured, skipping`);
    continue;
  }
  try {
    const stat = fs.statSync(projPath);
    if (!stat.isDirectory()) {
      logger.warn(`Project "${alias}": path "${projPath}" is not a directory, skipping`);
      console.error(`\u26a0 Project "${alias}": path "${projPath}" is not a directory, skipping`);
      continue;
    }
    validatedProjects[alias] = proj;
  } catch {
    logger.warn(`Project "${alias}": path "${projPath}" does not exist, skipping`);
    console.error(`\u26a0 Project "${alias}": path "${projPath}" does not exist, skipping`);
  }
}

if (Object.keys(validatedProjects).length === 0) {
  logger.error('No projects with valid paths found in config.listener.projects');
  console.error('No projects with valid paths found. Run "claude-notify listener setup" to configure.');
  process.exit(1);
}

config.listener.projects = validatedProjects;
const listenerConfig = config.listener;
const globalClaudeArgs = listenerConfig.claudeArgs || [];
const continueSessionEnabled = listenerConfig.continueSession !== false; // default: true
const taskTimeoutMinutes = listenerConfig.taskTimeoutMinutes || 30;
const taskTimeout = taskTimeoutMinutes * 60_000;
const resumeLastSessionEnabled = listenerConfig.resumeLastSession !== false; // default: true
const sessionsListLimit = listenerConfig.sessionsListLimit || 5;
const sessionWorkingThresholdSec = listenerConfig.sessionWorkingThresholdSec || 2;

const poller = new TelegramPoller(token, chatId, logger);
const queue = new WorkQueue(
  logger,
  listenerConfig.maxQueuePerWorkDir || 10,
  listenerConfig.maxTotalTasks || 50,
);
const taskLogDir = config.listener?.taskLogDir || listenerLogDir;
fs.mkdirSync(taskLogDir, { recursive: true });
const taskLogger = createTaskLogger(taskLogDir);

const runner = new PtyRunner(logger, taskTimeout, taskLogger, taskLogDir);

const worktreeManager = new WorktreeManager(config, logger);

const liveConsoleEnabled = listenerConfig.liveConsole !== false; // default: true
const liveConsoleIntervalMillis = listenerConfig.liveConsoleIntervalMillis || 1000;
const liveConsoleMaxOutputChars = listenerConfig.liveConsoleMaxOutputChars || 300;

const startTime = Date.now();

// Session tracking per workDir: { taskCount, lastSessionId, lastContextPct }
const sessions = new Map();
// WorkDirs that should start a fresh session on next task
const freshSessionDirs = new Set();
// WorkDirs with a pending resume request: workDir -> sessionId. Consumed by
// applyResumeArgs() on the next task, then cleared.
const pendingResumeBySid = new Map();
// Live console intervals per workDir
const liveConsoleTimers = new Map();
// JSONL readers per workDir (for live console from structured session data)
const jsonlReaders = new Map();
// Live console source: "jsonl" | "pty" | "auto" (default: "auto")
const liveConsoleSource = listenerConfig.liveConsoleSource || 'auto';
const jsonlMaxContentChars = listenerConfig.jsonlMaxContentChars || 500;

logger.info('Listener started');
logger.info(`Projects: ${JSON.stringify(Object.keys(listenerConfig.projects))}`);
logger.info(`Session continuity: ${continueSessionEnabled ? 'enabled' : 'disabled'}`);
logger.info(`Live console: ${liveConsoleEnabled ? `enabled (${liveConsoleIntervalMillis}ms interval, max ${liveConsoleMaxOutputChars} chars)` : 'disabled'}`);

// ----------------------
// DISCOVER WORKTREES ON START
// ----------------------

for (const alias of Object.keys(listenerConfig.projects)) {
  worktreeManager.discoverWorktrees(alias);
}

// ----------------------
// WATCHDOG + ORPHAN RECOVERY
// ----------------------

// Wall-clock watchdog: kills PTY sessions whose active task exceeded taskTimeout
// since startedAt. Complements the inactivity-based marker timeout in pty-runner —
// catches the case where Claude keeps emitting bytes (update checks, spinners)
// but never produces a Stop hook signal, so inactivity never accumulates.
async function runWatchdog () {
  const timeoutMin = Math.round(taskTimeout / 60000);
  for (const [workDir, entry] of Object.entries(queue.queues)) {
    if (!entry.active) {
      continue;
    }
    const startedAt = entry.active.startedAt ? new Date(entry.active.startedAt).getTime() : 0;
    if (startedAt <= 0 || (Date.now() - startedAt) <= taskTimeout) {
      continue;
    }
    const task = entry.active;
    const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
    logger.warn(`Watchdog: stale task "${task.id}" in ${workDir} (${elapsedMin}min) — killing PTY`);
    if (runner.isRunning(workDir)) {
      try {
        runner.cancel(workDir);
      } catch (err) {
        logger.error(`Watchdog: cancel PTY failed in ${workDir}: ${err.message}`);
      }
    }
    await notifyTaskCompletion(workDir, task, 'timeout', {
      timeoutMin,
      reason: `exceeded ${timeoutMin} min wall-clock limit`,
    });
  }
}

// 1. Initial watchdog sweep on startup. Must finish before orphan recovery,
// otherwise orphan recovery sees the stale active (still set) and re-spawns
// the killed task while watchdog is still awaiting its Telegram notify.
await runWatchdog();

// 2. Re-start orphaned active tasks (PTY sessions lost on restart)
for (const [workDir, entry] of Object.entries(queue.queues)) {
  if (entry.active && !runner.isRunning(workDir)) {
    logger.info(`Orphan recovery: re-starting task "${entry.active.id}" in ${workDir}`);
    startTask(workDir, entry.active);
  }
}

// 3. Periodic watchdog — wall-clock check every minute
setInterval(runWatchdog, 60_000);

// ----------------------
// TASK RUNNER EVENTS
// ----------------------

// Single completion path for runner events. Composes the final message and
// atomically replaces the running message via editMessage when possible — this
// avoids the prior delete-then-send race where a failed send would leave the
// user with no visible reply at all.
async function notifyTaskCompletion (workDir, task, kind, payload = {}) {
  stopLiveConsole(workDir);
  runner.cleanActivitySignal(workDir);
  const entry = queue.queues[workDir];
  const label = formatLabel(entry?.project, entry?.branch);
  const output = payload.text || '';

  // Build header
  let header;
  let queueResult;
  if (kind === 'error') {
    header = `❌  <code>${label}</code>\nError`;
    queueResult = `ERROR: ${payload.errorMsg}`;
  } else if (kind === 'timeout') {
    const reason = payload.reason || `no activity for ${payload.timeoutMin} min`;
    header = `⏰ <code>${label}</code>\nTask forcefully stopped — ${reason}`;
    queueResult = 'TIMEOUT';
  } else if (task.raw) {
    // /clear wipes Claude's context — reset our counters to match.
    if ((task.text || '').trim().toLowerCase() === '/clear') {
      sessions.delete(workDir);
    }
    header = `📨 <code>${label}</code>  sent <code>${escapeHtml(task.text)}</code>`;
    queueResult = output;
  } else {
    // Update session tracking for non-raw completions
    const session = sessions.get(workDir) || { taskCount: 0 };
    session.taskCount++;
    session.lastSessionId = payload.sessionId || session.lastSessionId;
    if (payload.contextWindow && payload.totalTokens) {
      session.lastContextPct = Math.round((payload.totalTokens / payload.contextWindow) * 100);
    }
    sessions.set(workDir, session);

    const parts = [];
    if (task.continueSession) {
      parts.push(`#${session.taskCount}`);
    }
    if (payload.durationMs) {
      parts.push(formatDuration(payload.durationMs));
    }
    if (payload.numTurns > 1) {
      parts.push(`${payload.numTurns} turns`);
    }
    if (session.lastContextPct) {
      parts.push(`ctx ${session.lastContextPct}%`);
    }
    if (payload.cost) {
      parts.push(`$${payload.cost.toFixed(2)}`);
    }
    const info = parts.length ? `  (${parts.join(', ')})` : '';
    const icon = task.continueSession ? '🔄' : '🆕';
    header = `✅ ${icon} <code>${label}</code>${info}`;
    queueResult = output;
  }

  // Build body. Long output → head+tail summary in chat plus full output as document.
  const errPayload = kind === 'error' ? payload.errorMsg : '';
  const visible = output || errPayload;
  let body = '';
  let attachFullOutput = false;
  if (visible) {
    if (visible.length > 20000) {
      const head = visible.slice(0, 2000);
      const tail = visible.slice(-2000);
      body = `\n\n<pre>${escapeHtml(head)}\n\n... (${visible.length} chars) ...\n\n${escapeHtml(tail)}</pre>`;
      attachFullOutput = true;
    } else {
      body = `\n\n<pre>${escapeHtml(visible)}</pre>`;
    }
  }

  const finalText = header + body;

  // Prefer atomic edit of the existing "Running" message — single Telegram entry,
  // no flicker, and if the edit fails we still have the running message visible.
  let edited = false;
  if (task.runningMessageId) {
    edited = await poller.editMessage(task.runningMessageId, finalText);
  }
  if (!edited) {
    // Edit failed (message deleted, or text exceeds 4096 chars and Telegram refused).
    // Send a fresh message; only delete the running one if the send succeeded.
    const sentId = await poller.sendMessage(finalText, task.telegramMessageId);
    if (!sentId && task.telegramMessageId) {
      // Fall back: send without reply (original may have been deleted)
      await poller.sendMessage(finalText);
    }
    if (sentId && task.runningMessageId) {
      await poller.deleteMessage(task.runningMessageId);
    }
  }

  if (attachFullOutput) {
    await poller.sendDocument(
      Buffer.from(visible, 'utf-8'),
      `result_${task.id}.txt`,
      `Full output for: ${task.text.slice(0, 100)}`,
    );
  }

  const next = queue.onTaskComplete(workDir, queueResult);
  if (next) {
    startTask(workDir, next);
  }
}

runner.on('complete', (workDir, task, result) => notifyTaskCompletion(workDir, task, 'complete', result));
runner.on('error', (workDir, task, errorMsg) => notifyTaskCompletion(workDir, task, 'error', { errorMsg }));
runner.on('timeout', (workDir, task) => notifyTaskCompletion(workDir, task, 'timeout', {
  timeoutMin: Math.round(taskTimeout / 60000),
}));

// ----------------------
// HELPERS
// ----------------------

function formatLabel (project, branch) {
  if (!project) {
    return 'unknown';
  }
  if (branch && branch !== 'main' && branch !== 'master') {
    return `&${project}/${branch}`;
  }
  return `&${project}`;
}

function getClaudeArgs (projectAlias) {
  const project = listenerConfig.projects[projectAlias];
  const projectArgs = (typeof project === 'object' && project.claudeArgs) || [];
  // Project-level args override global args
  return projectArgs.length > 0 ? projectArgs : globalClaudeArgs;
}

function hasAnyJsonl (workDir) {
  const dirName = cwdToProjectDir(workDir);
  const dirPath = path.join(CLAUDE_DIR, 'projects', dirName);
  try {
    return fs.readdirSync(dirPath).some(f => f.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

// Decide whether to add --continue or --resume <id> to claudeArgs for a fresh PTY.
// Priority: explicit caller flag > pending /resume <sid> > /newsession opt-out >
// global resumeLastSession default. If reusing an idle PTY, claudeArgs are ignored anyway.
function applyResumeArgs (claudeArgs, workDir) {
  if (claudeArgs.includes('--continue') || claudeArgs.includes('--resume')) {
    return claudeArgs;
  }
  if (pendingResumeBySid.has(workDir)) {
    const sid = pendingResumeBySid.get(workDir);
    pendingResumeBySid.delete(workDir);
    return [...claudeArgs, '--resume', sid];
  }
  // /newsession or /clear sets freshSessionDirs to opt out of auto-continue
  // for this one task (consumed here so subsequent tasks resume normally).
  if (freshSessionDirs.has(workDir)) {
    freshSessionDirs.delete(workDir);
    return claudeArgs;
  }
  if (resumeLastSessionEnabled && hasAnyJsonl(workDir)) {
    return [...claudeArgs, '--continue'];
  }
  return claudeArgs;
}

function formatTimeAgo (ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Reuse the in-memory PTY session only if one exists and the user hasn't asked
// for a fresh start. The freshSessionDirs flag is read here and *consumed* by
// applyResumeArgs (which also needs it to suppress --continue).
function shouldContinueSession (workDir) {
  if (!continueSessionEnabled) {
    return false;
  }
  if (freshSessionDirs.has(workDir)) {
    return false;
  }
  return sessions.has(workDir);
}

// Source priority: JSONL (richer, structured) → PTY buffer fallback.
// Returns short tail-content (~liveConsoleMaxOutputChars) or null.
function getLiveContent (workDir) {
  if (liveConsoleSource !== 'pty') {
    let reader = jsonlReaders.get(workDir);
    if (!reader) {
      const sid = runner.getSessionId(workDir);
      const jsonlPath = sid ? resolveJsonlPath(workDir, sid) : resolveJsonlByMtime(workDir);
      if (jsonlPath) {
        reader = new JsonlReader(jsonlPath, logger);
        jsonlReaders.set(workDir, reader);
        logger.info(`JSONL reader initialized: ${jsonlPath}`);
      }
    }
    if (reader) {
      reader.readNew();
      const content = reader.getDisplayContent(jsonlMaxContentChars);
      if (content) {
        return content;
      }
    }
    if (liveConsoleSource === 'jsonl') {
      return null;
    }
  }
  const cleaned = cleanPtyOutput(runner.getBuffer(workDir) || '');
  if (!cleaned) {
    return null;
  }
  if (cleaned.length <= liveConsoleMaxOutputChars) {
    return cleaned;
  }
  // Trim head to a clean line boundary
  const tail = cleaned.slice(-liveConsoleMaxOutputChars);
  const nl = tail.indexOf('\n');
  return nl >= 0 ? tail.slice(nl + 1) : tail;
}

const LIVE_CONSOLE_MAX_FAILS = 5;

function startLiveConsole (workDir, messageId, header) {
  stopLiveConsole(workDir);
  if (!liveConsoleEnabled || !messageId) {
    return;
  }
  let lastSentText = '';
  let consecutiveFails = 0;
  const timer = setInterval(async () => {
    const output = getLiveContent(workDir);
    if (!output || output === lastSentText) {
      return;
    }
    const startedAt = new Date(runner.getActive(workDir)?.startedAt || Date.now()).getTime();
    const elapsed = formatDuration(Date.now() - startedAt);
    const activity = runner.getActivity(workDir);
    const activityLine = activity && (Date.now() - activity.timestamp < 30000)
      ? `\n<b>${escapeHtml(formatActivity(activity))}</b>`
      : '';
    const text = `${header}\n<i>${elapsed}</i>${activityLine}\n\n<pre>${escapeHtml(output)}</pre>`;
    const ok = await poller.editMessage(messageId, text);
    if (ok) {
      lastSentText = output;
      consecutiveFails = 0;
      return;
    }
    consecutiveFails++;
    if (consecutiveFails >= LIVE_CONSOLE_MAX_FAILS) {
      logger.warn(`Live console stopped for ${workDir}: ${consecutiveFails} consecutive edit failures (message likely deleted)`);
      stopLiveConsole(workDir);
    }
  }, liveConsoleIntervalMillis);
  liveConsoleTimers.set(workDir, timer);
}

function stopLiveConsole (workDir) {
  const timer = liveConsoleTimers.get(workDir);
  if (timer) {
    clearInterval(timer);
    liveConsoleTimers.delete(workDir);
  }
  jsonlReaders.delete(workDir);
}

async function startTask (workDir, task) {
  const entry = queue.queues[workDir];
  const label = formatLabel(entry?.project, entry?.branch);
  const continueSession = shouldContinueSession(workDir);
  const session = sessions.get(workDir);

  // Build running header. Raw forwards a slash-command to the live PTY; non-raw
  // is a regular agent task with session info. Both reuse the live console so
  // long-running raw commands (e.g. SuperClaude skills) still show progress.
  let runningHeader;
  let runningFull;
  if (task.raw) {
    runningHeader = `📨 <code>${label}</code>  sending <code>${escapeHtml(task.text)}</code>…`;
    runningFull = runningHeader;
  } else {
    let sessionTag;
    if (continueSession && session) {
      const ctxPart = session.lastContextPct ? `, ctx ${session.lastContextPct}%` : '';
      sessionTag = ` 🔄 #${session.taskCount + 1}${ctxPart}`;
    } else {
      sessionTag = ' 🆕';
    }
    runningHeader = `⏳ <code>${label}</code>${sessionTag}\nRunning...`;
    runningFull = `⏳ <code>${label}</code>${sessionTag}\nRunning: ${escapeHtml(task.text)}`;
  }

  // Reply with short header (user message is already visible in the quote).
  // If reply target is gone, fall back to a fresh message that includes task text.
  let runningMsgId = task.telegramMessageId
    ? await poller.sendMessage(runningHeader, task.telegramMessageId)
    : null;
  if (!runningMsgId) {
    runningMsgId = await poller.sendMessage(runningFull);
  }

  task.runningMessageId = runningMsgId;
  startLiveConsole(workDir, runningMsgId, runningFull);

  const claudeArgs = applyResumeArgs(getClaudeArgs(entry?.project), workDir);
  try {
    runner.run(workDir, task, claudeArgs, continueSession);
    queue.markStarted(workDir, task.pid || 0);
  } catch (err) {
    logger.error(`Failed to start task: ${err.message}`);
    poller.sendMessage(`❌  <code>${label}</code>\nFailed to start: ${escapeHtml(err.message)}`);
    queue.onTaskComplete(workDir, `START_ERROR: ${err.message}`);
  }
}

function formatActivity (activity) {
  if (!activity) {
    return '';
  }
  const { toolName, toolInput } = activity;
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
      return toolInput?.file_path ? `${toolName}: ${path.basename(toolInput.file_path)}` : toolName;
    case 'Bash':
      return toolInput?.command ? `$ ${toolInput.command.slice(0, 80)}` : 'Bash';
    case 'Grep':
      return toolInput?.pattern ? `Grep: ${toolInput.pattern}` : 'Grep';
    case 'Glob':
      return toolInput?.pattern ? `Glob: ${toolInput.pattern}` : 'Glob';
    case 'Agent':
      return toolInput?.description ? `Agent: ${toolInput.description}` : 'Agent';
    case 'WebFetch':
      return toolInput?.url ? `Fetch: ${toolInput.url.slice(0, 60)}` : 'WebFetch';
    case 'WebSearch':
      return toolInput?.query ? `Search: ${toolInput.query}` : 'WebSearch';
    default:
      if (toolName?.startsWith('mcp__')) {
        const parts = toolName.split('__');
        return parts.length >= 3 ? `MCP ${parts[1]}: ${parts[2]}` : toolName;
      }
      return toolName || '';
  }
}

function formatDuration (ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) {
    return `${sec}s`;
  }
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

// ----------------------
// COMMAND HANDLERS
// ----------------------

async function handleCommand (cmd, args, messageId) {
  switch (cmd) {
    case '/status':
      return handleStatus(args);
    case '/queue':
      return handleQueue();
    case '/cancel':
      return handleCancel(args);
    case '/drop':
      return handleDrop(args);
    case '/clear':
      return handleClear(args);
    case '/clearchat':
      return handleClearChat(messageId);
    case '/newsession':
      return handleNewSession(args);
    case '/projects':
      return handleProjects();
    case '/add-project':
    case '/add_project':
    case '/addproject':
      return handleAddProject(args);
    case '/seen':
      return handleSeen(args);
    case '/setdefault':
      return handleSetDefault(args);
    case '/worktrees':
      return handleWorktrees(args);
    case '/worktree':
      return handleCreateWorktree(args);
    case '/rmworktree':
      return handleRemoveWorktree(args);
    case '/history':
      return handleHistory();
    case '/pty':
      return handlePty(args);
    case '/sessions':
      return handleSessions(args);
    case '/resume':
      return handleResumeSession(args, false);
    case '/kresume':
      return handleResumeSession(args, true);
    case '/stop':
      return handleStop();
    case '/help':
    case '/menu':
    case '/start':
      return handleHelp();
    default:
      return `Unknown command: ${cmd}`;
  }
}

function handleStatus (args) {
  const target = parseTarget(args);

  if (target) {
    const statuses = queue.getProjectStatus(target.project);
    if (statuses.length === 0) {
      return `📊 Project "${target.project}": no active queues`;
    }
    let text = `📊 Project "<b>${escapeHtml(target.project)}</b>":\n`;
    const buttons = [];
    for (const s of statuses) {
      const branchLabel = s.branch || 'main';
      const label = formatLabel(target.project, s.branch);
      if (s.active) {
        const elapsed = s.active.startedAt
          ? formatDuration(Date.now() - new Date(s.active.startedAt).getTime())
          : '?';
        text += `\n<b>${escapeHtml(branchLabel)}</b>:\n`;
        text += `  ▶ ${escapeHtml(s.active.text)} (${elapsed})\n`;
        text += `  Queue: ${s.queueLength} tasks\n`;
        buttons.push([
          { text: `🛑 Cancel ${label}`, callback_data: `/cancel ${label}` },
          { text: `🧹 Clear ${label}`, callback_data: `/clear ${label}` },
        ]);
      } else {
        text += `\n<b>${escapeHtml(branchLabel)}</b>: ✅ idle\n`;
        text += `  Queue: ${s.queueLength} tasks\n`;
      }
      buttons.push([
        { text: `🆕 New session ${label}`, callback_data: `/newsession ${label}` },
      ]);
    }
    if (buttons.length > 0) {
      return { text, replyMarkup: { inline_keyboard: buttons } };
    }
    return text;
  }

  // All projects
  const all = queue.getAllStatus();
  if (Object.keys(all).length === 0) {
    const uptime = formatDuration(Date.now() - startTime);
    return `📊 No active tasks\nUptime: ${uptime}`;
  }

  let text = '📊 <b>Status:</b>\n';
  const uptime = formatDuration(Date.now() - startTime);
  text += `Uptime: ${uptime}\n`;
  const buttons = [];
  for (const [project, statuses] of Object.entries(all)) {
    text += `\n<b>${escapeHtml(project)}</b>:`;
    for (const s of statuses) {
      const branchLabel = s.branch || 'main';
      const label = formatLabel(project, s.branch);
      if (s.active) {
        const elapsed = s.active.startedAt
          ? formatDuration(Date.now() - new Date(s.active.startedAt).getTime())
          : '?';
        text += `\n  ${escapeHtml(branchLabel)}: ▶ ${escapeHtml(s.active.text)} (${elapsed})`;
        if (s.queueLength > 0) {
          text += ` +${s.queueLength} queued`;
        }
        buttons.push([
          { text: `🛑 Cancel ${label}`, callback_data: `/cancel ${label}` },
          { text: `🧹 Clear ${label}`, callback_data: `/clear ${label}` },
        ]);
      } else {
        text += `\n  ${escapeHtml(branchLabel)}: ✅ idle`;
      }
      buttons.push([
        { text: `🆕 New session ${label}`, callback_data: `/newsession ${label}` },
      ]);
    }
  }
  if (buttons.length > 0) {
    return { text, replyMarkup: { inline_keyboard: buttons } };
  }
  return text;
}

function handleQueue () {
  const all = queue.getAllStatus();
  if (Object.keys(all).length === 0) {
    return '📋 All queues are empty';
  }

  let text = '📋 <b>Queues:</b>\n';
  for (const [project, statuses] of Object.entries(all)) {
    for (const s of statuses) {
      if (!s.active && s.queueLength === 0) {
        continue;
      }
      const label = formatLabel(project, s.branch);
      text += `\n<b>${escapeHtml(label)}</b>:`;
      if (s.active) {
        text += `\n  ▶ ${escapeHtml(s.active.text)}`;
      }
      // s.workDir comes from queue.getProjectStatus / getAllStatus — no n^2 lookup needed.
      const entry = s.workDir ? queue.queues[s.workDir] : null;
      if (entry?.queue) {
        for (let i = 0; i < entry.queue.length; i++) {
          text += `\n  ${i + 1}. ${escapeHtml(entry.queue[i].text)}`;
        }
      }
    }
  }
  return text;
}

async function handleCancel (args) {
  const target = parseTarget(args);
  const projectAlias = target?.project || getDefaultProject(listenerConfig.projects);
  const branch = target?.branch || null;

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(projectAlias, branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }

  const label = formatLabel(projectAlias, branch);
  if (!runner.isRunning(workDir)) {
    return `❌ No active task in ${escapeHtml(label)}`;
  }

  runner.cancel(workDir);
  const next = queue.cancelActive(workDir);

  if (next) {
    startTask(workDir, next);
    return `🛑 [${escapeHtml(label)}] Task cancelled. Starting next.`;
  }
  return `🛑 [${escapeHtml(label)}] Task cancelled`;
}

function handleDrop (args) {
  const target = parseTarget(args);
  if (!target) {
    return '❌ Usage: /drop &project N';
  }
  const index = parseInt(target.rest, 10);
  if (!index || index < 1) {
    return '❌ Specify task number (starting from 1)';
  }

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(target.project, target.branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }

  const removed = queue.removeFromQueue(workDir, index);
  if (!removed) {
    return `❌ Task #${index} not found in queue`;
  }
  return `🗑 Removed from queue: ${escapeHtml(removed.text)}`;
}

function handleClear (args) {
  const target = parseTarget(args);
  const projectAlias = target?.project || getDefaultProject(listenerConfig.projects);
  const branch = target?.branch || null;

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(projectAlias, branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }

  const count = queue.clearQueue(workDir);
  const label = formatLabel(projectAlias, branch);

  // Also reset session
  sessions.delete(workDir);
  freshSessionDirs.add(workDir);
  logger.info(`Session reset for ${workDir} via /clear`);

  return `🧹 [${escapeHtml(label)}] Queue cleared (${count} tasks), session reset`;
}

// Sweep deletes the bot's outgoing messages in the private chat. We can't
// know the bot's message-id range, so we walk backwards from the user's
// /clearchat command id and ask Telegram to delete each id. The bot has no
// permission to delete the user's own messages in private chats — those
// requests fail silently and don't count. We stop early when an entire
// parallel batch comes back as failures (we've passed the bot's recent
// outputs into a stretch of user-only messages, or hit the 48h delete window).
async function handleClearChat (messageId) {
  if (!messageId || messageId < 2) {
    return '❌ /clearchat needs a message context';
  }
  const BATCH = 25;       // ≤ Telegram's 30 req/sec ceiling for a single chat
  const MAX_LOOKBACK = 5000;

  let deleted = 0;
  let attempted = 0;
  let cursor = messageId - 1;
  while (cursor > 0 && attempted < MAX_LOOKBACK) {
    const ids = [];
    for (let i = 0; i < BATCH && cursor - i > 0; i++) {
      ids.push(cursor - i);
    }
    const results = await Promise.all(ids.map((id) => poller.deleteMessage(id)));
    attempted += results.length;
    const ok = results.filter(Boolean).length;
    deleted += ok;
    cursor -= BATCH;
    if (ok === 0) {
      break;
    }
  }
  // Also drop the user's /clearchat command itself — works only if Telegram
  // accepts it (e.g. bot is admin in a group); silently skipped in private chats.
  await poller.deleteMessage(messageId);
  return `🧹 Deleted ${deleted} of ${attempted} bot messages.`;
}

function handleNewSession (args) {
  const target = parseTarget(args);
  const projectAlias = target?.project || getDefaultProject(listenerConfig.projects);
  const branch = target?.branch || null;

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(projectAlias, branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }

  const label = formatLabel(projectAlias, branch);
  const session = sessions.get(workDir);

  sessions.delete(workDir);
  freshSessionDirs.add(workDir);
  logger.info(`Session reset for ${workDir} via /newsession`);

  if (session) {
    return `🆕 [${escapeHtml(label)}] Session reset (was #${session.taskCount} tasks, ctx ${session.lastContextPct || '?'}%). Next task starts fresh.`;
  }
  return `🆕 [${escapeHtml(label)}] Next task will start a new session.`;
}

function handleProjects () {
  const projects = listenerConfig.projects;
  const defaultAlias = getDefaultProject(projects);
  let text = '📂 <b>Projects:</b>\n';
  for (const [alias, proj] of Object.entries(projects)) {
    const projPath = typeof proj === 'string' ? proj : proj.path;
    const icon = alias === defaultAlias ? '🏠 ' : '';
    text += `\n${icon}<b>&${escapeHtml(alias)}</b> → <code>${escapeHtml(projPath)}</code>`;
    const worktrees = typeof proj === 'object' ? proj.worktrees : null;
    if (worktrees && Object.keys(worktrees).length > 0) {
      for (const [branch, wtPath] of Object.entries(worktrees)) {
        text += `\n  /${escapeHtml(branch)} → <code>${escapeHtml(wtPath)}</code>`;
      }
    }
  }

  const buttons = [];
  // "Set Default" button
  buttons.push([{ text: '🏠 Set Default', callback_data: '/setdefault' }]);

  return { text, replyMarkup: { inline_keyboard: buttons } };
}

function handleSetDefault (args) {
  const projects = listenerConfig.projects;

  // No args — show inline keyboard with project list
  if (!args || !args.trim()) {
    const defaultAlias = getDefaultProject(projects);
    const buttons = [];
    for (const [alias, proj] of Object.entries(projects)) {
      const projPath = typeof proj === 'string' ? proj : proj.path;
      const icon = alias === defaultAlias ? '🏠 ' : '';
      buttons.push([{
        text: `${icon}${alias} — ${projPath}`,
        callback_data: `/setdefault ${alias}`,
      }]);
    }
    return {
      text: '🏠 <b>Select default project:</b>',
      replyMarkup: { inline_keyboard: buttons },
    };
  }

  // Args provided — set the default
  const alias = args.trim();
  if (!projects[alias]) {
    return `❌ Project "<b>${escapeHtml(alias)}</b>" not found. Use /projects to list.`;
  }

  // Clear isDefault from all projects, set on chosen
  for (const proj of Object.values(projects)) {
    if (typeof proj === 'object') {
      delete proj.isDefault;
    }
  }
  const proj = projects[alias];
  if (typeof proj === 'object') {
    proj.isDefault = true;
  }

  // Persist to config file
  try {
    saveConfig(config);
    logger.info(`Default project changed to "${alias}"`);
  } catch (err) {
    logger.error(`Failed to save config: ${err.message}`);
    return `❌ Failed to save config: ${escapeHtml(err.message)}`;
  }

  const projPath = typeof proj === 'string' ? proj : proj.path;
  return `✅ Default project: <b>&${escapeHtml(alias)}</b> → <code>${escapeHtml(projPath)}</code>`;
}

// ----------------------
// /add-project and /seen
// ----------------------

function isBasenameRef (s) {
  // "/foo" — one leading slash + single path segment, no second slash,
  // no backslash, no drive letter. Everything else → explicit path.
  return /^\/[^/\\:]+$/.test(s);
}

function formatAge (iso) {
  if (!iso) {
    return '?';
  }
  const diffMs = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diffMs)) {
    return '?';
  }
  if (diffMs < 0) {
    return 'now';
  }
  const s = Math.floor(diffMs / 1000);
  if (s < 60) {
    return `${s}s ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ago`;
  }
  const d = Math.floor(h / 24);
  if (d < 30) {
    return `${d}d ago`;
  }
  return new Date(iso).toISOString().slice(0, 10);
}

function handleAddProject (args) {
  const trimmed = (args || '').trim();
  const usage = `❌ Usage: /addproject &lt;alias&gt; &lt;path-or-/basename&gt;

Examples:
  /addproject mj D:/DEV/FA/_cur/mcp-jira   — explicit path
  /addproject mj /mcp-jira                  — resolve from last notification
  /addproject mj /mcp-jira/                 — Unix: literal /mcp-jira directory

Aliases for this command: /add-project, /add_project`;

  if (!trimmed) {
    return usage;
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return usage;
  }
  const alias = parts[0];
  const rawTarget = parts.slice(1).join(' ');

  if (!/^[a-zA-Z0-9_-]+$/.test(alias)) {
    return `❌ Invalid alias "<b>${escapeHtml(alias)}</b>". Allowed: letters, digits, underscore, hyphen.`;
  }
  if (listenerConfig.projects[alias]) {
    return `❌ Alias "<b>${escapeHtml(alias)}</b>" already exists. Use /projects to list.`;
  }

  // Resolve target → absolute path
  let absPath;
  if (isBasenameRef(rawTarget)) {
    const { entries } = loadSeenProjects();
    const basename = rawTarget.replace(/^\/+/, '');
    const matches = entries
      .filter((e) => e.basename === basename)
      .sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    if (matches.length === 0) {
      return `❌ Unknown basename "/${escapeHtml(basename)}". No notification from such folder was seen yet. Use /seen to list recent folders.`;
    }
    absPath = matches[0].path;
  } else {
    absPath = rawTarget;
  }

  // Validate directory exists
  try {
    if (!fs.statSync(absPath).isDirectory()) {
      return `❌ Path is not a directory: <code>${escapeHtml(absPath)}</code>`;
    }
  } catch {
    return `❌ Path does not exist: <code>${escapeHtml(absPath)}</code>`;
  }

  // Normalize to forward slashes (match existing config style)
  absPath = absPath.replace(/\\/g, '/');

  // Check: path already registered under another alias?
  const normalizedNew = normalizeForCompare(absPath);
  for (const [existingAlias, proj] of Object.entries(listenerConfig.projects)) {
    const existingPath = typeof proj === 'string' ? proj : proj?.path;
    if (!existingPath) {
      continue;
    }
    if (normalizeForCompare(existingPath) === normalizedNew) {
      return `❌ Path already registered as <b>&${escapeHtml(existingAlias)}</b> → <code>${escapeHtml(existingPath)}</code>`;
    }
  }

  // Mutate config + persist
  listenerConfig.projects[alias] = {
    path: absPath,
    claudeArgs: [],
    worktrees: {},
  };
  try {
    saveConfig(config);
  } catch (err) {
    delete listenerConfig.projects[alias];
    logger.error(`Failed to save config: ${err.message}`);
    return `❌ Failed to save config: ${escapeHtml(err.message)}`;
  }

  // Discover worktrees for the new project (consistency with startup flow)
  try {
    worktreeManager.discoverWorktrees(alias);
  } catch (err) {
    logger.warn(`discoverWorktrees failed for ${alias}: ${err.message}`);
  }

  logger.info(`Project added: ${alias} → ${absPath}`);
  return `✅ Project added: <b>&${escapeHtml(alias)}</b> → <code>${escapeHtml(absPath)}</code>`;
}

function handleSeen (args) {
  const sub = (args || '').trim().toLowerCase();

  if (sub === 'clear' || sub === 'reset') {
    let count = 0;
    try {
      const data = loadSeenProjects();
      count = data.entries.length;
      // Atomic overwrite with an empty list
      const tmp = `${SEEN_PROJECTS_PATH}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries: [] }, null, 2));
      fs.renameSync(tmp, SEEN_PROJECTS_PATH);
    } catch (err) {
      logger.error(`Failed to clear seen file: ${err.message}`);
      return `❌ Failed to clear seen file: ${escapeHtml(err.message)}`;
    }
    logger.info(`Seen file cleared (${count} entries removed)`);
    return `✅ Seen file cleared (${count} entries removed).`;
  }

  if (sub && sub !== '') {
    return `❌ Unknown subcommand "<b>${escapeHtml(sub)}</b>". Usage: /seen [clear]`;
  }

  const { entries } = loadSeenProjects();
  if (!entries || entries.length === 0) {
    return 'ℹ No seen folders yet. Notifier will populate this list as you receive notifications.';
  }

  // Build alias index: normalized project path → alias
  const aliasByPath = new Map();
  for (const [alias, proj] of Object.entries(listenerConfig.projects)) {
    const p = typeof proj === 'string' ? proj : proj?.path;
    if (p) {
      aliasByPath.set(normalizeForCompare(p), alias);
    }
  }

  // Sort by lastSeen desc (defensive — notifier already does this)
  const sorted = [...entries].sort(
    (a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''),
  );

  const rows = sorted.map((e, i) => ({
    num: String(i + 1),
    alias: aliasByPath.get(normalizeForCompare(e.path)) || '—',
    age: formatAge(e.lastSeen),
    projPath: e.path,
  }));
  const wNum = Math.max(...rows.map((r) => r.num.length));
  const wAlias = Math.max(...rows.map((r) => r.alias.length), 5);
  const wAge = Math.max(...rows.map((r) => r.age.length), 3);

  const lines = rows.map((r) => `${r.num.padStart(wNum)}  ${r.alias.padEnd(wAlias)}  ${r.age.padStart(wAge)}  ${r.projPath}`);

  return {
    text: `📂 <b>Recent folders</b> (${rows.length}/${MAX_SEEN_ENTRIES}):
<pre>${escapeHtml(lines.join('\n'))}</pre>`,
  };
}

function handleWorktrees (args) {
  const target = parseTarget(args);
  if (!target) {
    return '❌ Usage: /worktrees &project';
  }

  const result = worktreeManager.listWorktrees(target.project);
  if (!result) {
    return `❌ Project "${escapeHtml(target.project)}" not found`;
  }

  let text = `🌳 Worktrees for "<b>${escapeHtml(target.project)}</b>":\n`;
  text += `\n• <b>main</b> → <code>${escapeHtml(result.main)}</code>`;
  for (const [branch, wtPath] of Object.entries(result.worktrees)) {
    text += `\n• <b>${escapeHtml(branch)}</b> → <code>${escapeHtml(wtPath)}</code>`;
  }
  return text;
}

function handleCreateWorktree (args) {
  const target = parseTarget(args);
  if (!target || !target.branch) {
    return '❌ Usage: /worktree &project/branch';
  }

  const branch = target.branch;
  try {
    const wtDir = worktreeManager.createWorktree(target.project, branch);
    return `🌿 Created worktree for "<b>${escapeHtml(target.project)}</b>":\n`
      + `Branch: <b>${escapeHtml(branch)}</b>\n`
      + `Path: <code>${escapeHtml(wtDir)}</code>`;
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }
}

function handleRemoveWorktree (args) {
  const target = parseTarget(args);
  if (!target || !target.branch) {
    return '❌ Usage: /rmworktree &project/branch';
  }

  const branch = target.branch;

  // Check if there's an active task in this worktree
  let workDir;
  try {
    const project = listenerConfig.projects[target.project];
    workDir = project?.worktrees?.[branch];
  } catch {
    // ignore
  }

  if (workDir && runner.isRunning(workDir)) {
    return `❌ Cannot remove worktree: task is running. First /cancel &${escapeHtml(target.project)}/${escapeHtml(branch)}`;
  }

  try {
    worktreeManager.removeWorktree(target.project, branch);
    return `🗑 Worktree <b>${escapeHtml(branch)}</b> removed from "<b>${escapeHtml(target.project)}</b>"`;
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }
}

function handlePty (args) {
  const target = parseTarget(args);

  if (target) {
    let workDir;
    try {
      workDir = worktreeManager.resolveWorkDir(target.project, target.branch);
    } catch (err) {
      return `❌ ${escapeHtml(err.message)}`;
    }
    const info = runner.getSessionInfo(workDir);
    if (!info) {
      return `🖥 No PTY session for ${escapeHtml(formatLabel(target.project, target.branch))}`;
    }
    return formatPtyInfo(target.project, target.branch, workDir, info);
  }

  // All sessions
  const allInfo = runner.getAllSessionInfo();
  if (Object.keys(allInfo).length === 0) {
    return '🖥 No active PTY sessions';
  }

  let text = '🖥 <b>PTY Sessions:</b>\n';
  for (const [workDir, info] of Object.entries(allInfo)) {
    const entry = queue.queues[workDir];
    const project = entry?.project || '?';
    const branch = entry?.branch || null;
    text += '\n' + formatPtyInfo(project, branch, workDir, info);
  }
  return text;
}

function formatPtyInfo (project, branch, workDir, info) {
  const label = formatLabel(project, branch);
  const elapsed = info.startedAt
    ? formatDuration(Date.now() - new Date(info.startedAt).getTime())
    : '-';
  const liveTimer = liveConsoleTimers.has(workDir) ? '✅' : '❌';
  const hasJsonl = jsonlReaders.has(workDir) ? '✅' : '❌';

  const liveContent = getLiveContent(workDir);
  const lastLines = liveContent
    ? liveContent.split('\n').slice(-15).join('\n')
    : '(empty)';

  return `<b>${escapeHtml(label)}</b>
State: <code>${info.state}</code>
Buffer: <code>${info.bufferSize}</code> bytes
Elapsed: ${elapsed}
Live console: ${liveTimer}
JSONL source: ${hasJsonl}
PTY log: <code>${info.hasLogStream ? 'writing' : 'off'}</code>

<pre>${escapeHtml(lastLines)}</pre>`;
}

async function handleSessions (args) {
  let target = parseTarget(args);
  if (!target) {
    const def = getDefaultProject(listenerConfig.projects);
    if (!def) {
      return 'Usage: /sessions &project[/branch]';
    }
    target = { project: def, branch: null };
  }
  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(target.project, target.branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }
  const labelTarget = formatLabel(target.project, target.branch);

  const items = await listSessions(workDir, {
    limit: sessionsListLimit,
    workingThresholdSec: sessionWorkingThresholdSec,
    logger,
  });
  if (items.length === 0) {
    return `📋 No sessions found for ${escapeHtml(labelTarget)}`;
  }

  let text = `📋 <b>Sessions for ${escapeHtml(labelTarget)}</b> (${items.length} most recent)`;
  const buttons = [];
  let idx = 0;
  for (const s of items) {
    idx++;
    const ago = formatTimeAgo(Date.now() - s.mtime);
    const sizeKb = s.size / 1024;
    const sizeStr = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${Math.round(sizeKb)} KB`;
    let icon;
    let statusLabel;
    if (s.status === 'working') {
      icon = '🔴';
      statusLabel = 'working';
    } else if (s.status === 'idle') {
      icon = '🟡';
      statusLabel = 'alive idle';
    } else {
      icon = '🟢';
      statusLabel = 'free';
    }
    const lockInfo = s.lockedBy.length > 0 ? ` · pid ${s.lockedBy.join(',')}` : '';
    const preview = s.preview ? escapeHtml(s.preview) : '<i>(no user message yet)</i>';
    text += `\n\n<b>${idx}.</b> ${icon} ${statusLabel} · ${ago} · ${sizeStr}${lockInfo}\n<code>${s.sessionId}</code>\n${preview}`;

    if (s.status === 'working') {
      // Skip — resuming a file being actively written would corrupt JSONL.
    } else if (s.status === 'idle') {
      buttons.push([
        { text: `${idx}. ⚠️ Kill & Resume`, callback_data: `/kresume ${labelTarget} ${s.sessionId}` },
      ]);
    } else {
      buttons.push([
        { text: `${idx}. ▶ Resume`, callback_data: `/resume ${labelTarget} ${s.sessionId}` },
      ]);
    }
  }

  if (buttons.length === 0) {
    return text + '\n\n<i>All sessions are actively in use — cannot resume safely.</i>';
  }
  return { text, replyMarkup: { inline_keyboard: buttons } };
}

async function handleResumeSession (args, kill) {
  const tokens = (args || '').trim().split(/\s+/).filter(Boolean);
  const cmdName = kill ? '/kresume' : '/resume';
  if (tokens.length < 2) {
    return `Usage: ${cmdName} &project[/branch] &lt;sessionId&gt;`;
  }
  const target = parseTarget(tokens[0]);
  if (!target) {
    return `Invalid project alias: ${escapeHtml(tokens[0])}`;
  }
  const sessionId = tokens[1];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    return `Invalid session ID: <code>${escapeHtml(sessionId)}</code>`;
  }

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(target.project, target.branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }
  const labelTarget = formatLabel(target.project, target.branch);

  const dirName = cwdToProjectDir(workDir);
  const filePath = path.join(CLAUDE_DIR, 'projects', dirName, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) {
    return `Session not found: <code>${escapeHtml(sessionId)}</code>`;
  }

  let killReport = '';
  if (kill) {
    const lockMap = await findLocking([filePath], logger);
    const pids = lockMap.get(filePath) || [];
    if (pids.length === 0) {
      killReport = '\n<i>No active locker found — proceeding with resume.</i>';
    } else {
      let killed = 0;
      for (const pid of pids) {
        if (await killPid(pid, logger)) {
          killed++;
        }
      }
      logger.info(`/kresume: killed ${killed}/${pids.length} processes locking ${sessionId}: ${pids.join(',')}`);
      // Brief settle delay so the OS releases the file handle.
      await new Promise((r) => setTimeout(r, 500));
      killReport = `\n<i>Killed ${killed}/${pids.length} process(es): ${pids.join(', ')}</i>`;
    }
  }

  // Drop any live PTY in this workDir so the next task spawns a fresh one with --resume.
  if (runner.isPtyAlive(workDir)) {
    try {
      runner.cancel(workDir);
    } catch (err) {
      logger.warn(`/resume: cancel PTY failed: ${err.message}`);
    }
    stopLiveConsole(workDir);
    runner.cleanActivitySignal(workDir);
  }
  freshSessionDirs.add(workDir);
  pendingResumeBySid.set(workDir, sessionId);

  return `🔄 ${escapeHtml(labelTarget)}: next task will resume <code>${sessionId.slice(0, 8)}…</code>${killReport}\n\nSend the task as usual:\n<code>${escapeHtml(labelTarget)} your task here</code>`;
}

function handleHistory () {
  const history = queue.getHistory(10);
  if (history.length === 0) {
    return '📜 History is empty';
  }
  let text = '📜 <b>Recent tasks:</b>\n';
  for (const h of history.reverse()) {
    const label = formatLabel(h.project, h.branch);
    const status = h.result === 'CANCELLED' ? '🛑' : h.result?.startsWith('ERROR') ? '❌' : '✅';
    text += `\n${status} [${escapeHtml(label)}] ${escapeHtml(h.text)}`;
  }
  return text;
}

async function handleStop () {
  await poller.sendMessage('👋 Listener shutting down...');
  runner.cancelAll();
  logger.info('Graceful shutdown requested via /stop');
  setTimeout(() => process.exit(0), 1000);
  return null; // Message already sent
}

const MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📊 Status', callback_data: '/status' },
      { text: '📋 Queue', callback_data: '/queue' },
      { text: '📂 Projects', callback_data: '/projects' },
    ],
    [
      { text: '📜 History', callback_data: '/history' },
      { text: '🖥 PTY', callback_data: '/pty' },
      { text: '📋 Sessions', callback_data: '/sessions' },
    ],
    [
      { text: '🏠 Default', callback_data: '/setdefault' },
    ],
    [
      { text: '📖 Help', callback_data: '/help' },
    ],
  ],
};

function handleHelp () {
  return {
    text: `<b>📖 Commands:</b>

/status — status of all projects
/status &project — project status
/queue — all queues
/cancel [&project[/branch]] — cancel task
/drop &project N — remove task from queue
/clear &project[/branch] — clear queue + reset session
/clearchat — delete the bot's messages in this chat (private chats: bot's own; groups: all if admin)
/newsession [&project[/branch]] — reset session (keep queue)
/projects — list projects
/addproject &lt;alias&gt; &lt;path-or-/basename&gt; — register a project
/seen — recent folders seen by notifier
/seen clear — wipe the seen list
/setdefault — change default project
/worktrees &project — project worktrees
/worktree &project/branch — create worktree
/rmworktree &project/branch — remove worktree
/pty [&project[/branch]] — PTY session diagnostics
/sessions [&project[/branch]] — list 5 most recent CC sessions with resume buttons
/resume &project[/branch] &lt;sessionId&gt; — next task resumes the given session
/kresume &project[/branch] &lt;sessionId&gt; — kill the holder, then resume
/history — task history
/stop — stop listener
/menu — command buttons
/help — this help

<b>Tasks:</b>
<code>&amp;project task</code> — main worktree
<code>&amp;project/branch task</code> — worktree
<code>task</code> — default project

<b>Raw REPL commands (forward to live Claude session):</b>
<code>%clear</code> — send <code>/clear</code> into the running Claude PTY
<code>&amp;project %compact</code> — same, targeting project
<code>%%foo</code> — literal task starting with <code>%foo</code> (escape)

<b>Session:</b>
🆕 = new session, 🔄 = continuing session
ctx N% = context window usage`,
    replyMarkup: MENU_KEYBOARD,
  };
}

// ----------------------
// TASK HANDLER
// ----------------------

async function handleTask (parsed, telegramMessageId) {
  let workDir;
  let autoCreated = false;

  try {
    const project = listenerConfig.projects[parsed.project];
    if (!project) {
      await poller.sendMessage(`❌ Project "<b>${escapeHtml(parsed.project)}</b>" not found. Use /projects to list.`);
      return;
    }

    // Check if worktree needs auto-creation (for notification)
    if (parsed.branch) {
      const existing = typeof project === 'object' && project.worktrees?.[parsed.branch];
      if (!existing) {
        autoCreated = true;
      }
    }

    workDir = worktreeManager.resolveWorkDir(parsed.project, parsed.branch);
  } catch (err) {
    await poller.sendMessage(`❌ ${escapeHtml(err.message)}`);
    return;
  }

  if (autoCreated) {
    await poller.sendMessage(`🌿 Created worktree <b>${escapeHtml(parsed.branch)}</b> for "<b>${escapeHtml(parsed.project)}</b>"`);
    logger.info(`Auto-created worktree for task: &${parsed.project}/${parsed.branch} → ${workDir}`);
  }

  const result = queue.enqueue(
    workDir,
    parsed.project,
    parsed.branch || 'main',
    parsed.text,
    telegramMessageId,
    !!parsed.raw,
  );

  if (result.error) {
    await poller.sendMessage(`❌ ${escapeHtml(result.error)}`);
    return;
  }

  if (result.immediate) {
    startTask(workDir, result.task);
  } else {
    const entry = queue.queues[workDir];
    const label = formatLabel(entry?.project, entry?.branch);
    await poller.sendMessage(
      `📋 [${escapeHtml(label)}] Queued (position ${result.position}).\n`
      + `Currently running: ${escapeHtml(result.activeTask.text)}`,
      telegramMessageId,
    );
  }
}

// ----------------------
// MAIN LOOP
// ----------------------

let running = true;

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM');
  running = false;
  for (const wd of liveConsoleTimers.keys()) {
    stopLiveConsole(wd);
  }
  runner.cancelAll();
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT');
  running = false;
  for (const wd of liveConsoleTimers.keys()) {
    stopLiveConsole(wd);
  }
  runner.cancelAll();
  setTimeout(() => process.exit(0), 2000);
});

async function mainLoop () {
  while (running) {
    try {
      const messages = await poller.getUpdates();
      for (const msg of messages) {
        // Answer callback query (Telegram requires this)
        if (msg.callbackQueryId) {
          await poller.answerCallbackQuery(msg.callbackQueryId);
        }

        const parsed = parseMessage(msg.text, getDefaultProject(listenerConfig.projects));
        if (!parsed) {
          continue;
        }

        if (parsed.type === 'command') {
          logger.info(`Command: ${parsed.cmd} ${parsed.args}`);
          const response = await handleCommand(parsed.cmd, parsed.args, msg.messageId);
          if (response) {
            if (typeof response === 'object' && response.text) {
              await poller.sendMessage(response.text, msg.callbackQueryId ? null : msg.messageId, response.replyMarkup);
            } else {
              await poller.sendMessage(response, msg.callbackQueryId ? null : msg.messageId);
            }
          }
        } else if (parsed.type === 'task') {
          logger.info(`Task for ${formatLabel(parsed.project, parsed.branch)}: ${parsed.text}`);
          await handleTask(parsed, msg.messageId);
        }
      }
    } catch (err) {
      logger.error(`Main loop error: ${err.message}`);
      // Wait before retrying on error
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

(async () => {
  await poller.flush();
  await poller.setMyCommands([
    { command: 'status', description: 'Status of all projects' },
    { command: 'queue', description: 'Show all queues' },
    { command: 'projects', description: 'List projects' },
    { command: 'addproject', description: 'Register a project alias' },
    { command: 'seen', description: 'Recent folders seen by notifier' },
    { command: 'setdefault', description: 'Change default project' },
    { command: 'history', description: 'Recent task history' },
    { command: 'pty', description: 'PTY session diagnostics' },
    { command: 'sessions', description: 'List recent CC sessions' },
    { command: 'clearchat', description: 'Delete the bot\'s messages in this chat' },
    { command: 'help', description: 'Show all commands' },
    { command: 'stop', description: 'Stop listener' },
  ]);
  await mainLoop();
})();
