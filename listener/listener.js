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
import { JsonlReader, resolveJsonlPath, resolveJsonlByMtime } from './jsonl-reader.js';

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

// 1. Clean up tasks that exceeded taskTimeout
const recovered = queue.watchdog(taskTimeout);
for (const { workDir, next } of recovered) {
  if (next) {
    startTask(workDir, next);
  }
}

// 2. Re-start orphaned active tasks (PTY sessions lost on restart)
for (const [workDir, entry] of Object.entries(queue.queues)) {
  if (entry.active && !runner.isRunning(workDir)) {
    logger.info(`Orphan recovery: re-starting task "${entry.active.id}" in ${workDir}`);
    startTask(workDir, entry.active);
  }
}

// ----------------------
// TASK RUNNER EVENTS
// ----------------------

runner.on('complete', async (workDir, task, result) => {
  stopLiveConsole(workDir);
  runner.cleanActivitySignal(workDir);
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);

  // Delete the "Running" message
  await poller.deleteMessage(task.runningMessageId);

  const output = result.text || '';

  if (task.raw) {
    // Raw slash-command: compact "sent" confirmation, don't bump session counter.
    // `/clear` wipes Claude's context — reset our counters too.
    const normalized = (task.text || '').trim().toLowerCase();
    if (normalized === '/clear') {
      sessions.delete(workDir);
    }
    const headerShort = `📨 <code>${label}</code>  sent <code>${escapeHtml(task.text)}</code>`;
    const tail = output ? output.slice(-1500) : '';
    const body = tail ? `\n\n<pre>${escapeHtml(tail)}</pre>` : '';
    const sentId = await poller.sendMessage(headerShort + body, task.telegramMessageId);
    if (!sentId && task.telegramMessageId) {
      await poller.sendMessage(headerShort + body);
    }
    const next = queue.onTaskComplete(workDir, output);
    if (next) {
      startTask(workDir, next);
    }
    return;
  }

  // Update session tracking
  const session = sessions.get(workDir) || { taskCount: 0 };
  session.taskCount++;
  session.lastSessionId = result.sessionId || session.lastSessionId;
  if (result.contextWindow && result.totalTokens) {
    session.lastContextPct = Math.round((result.totalTokens / result.contextWindow) * 100);
  }
  sessions.set(workDir, session);

  // Build session info line
  const sessionParts = [];
  if (task.continueSession) {
    sessionParts.push(`#${session.taskCount}`);
  }
  if (result.durationMs) {
    sessionParts.push(formatDuration(result.durationMs));
  }
  if (result.numTurns > 1) {
    sessionParts.push(`${result.numTurns} turns`);
  }
  if (session.lastContextPct) {
    sessionParts.push(`ctx ${session.lastContextPct}%`);
  }
  if (result.cost) {
    sessionParts.push(`$${result.cost.toFixed(2)}`);
  }
  const sessionInfo = sessionParts.length > 0 ? `  (${sessionParts.join(', ')})` : '';
  const sessionIcon = task.continueSession ? '🔄' : '🆕';

  // Build result
  const headerShort = `✅ ${sessionIcon} <code>${label}</code>${sessionInfo}`;
  const headerFull = `${headerShort}\n\n${escapeHtml(task.text)}`;
  let body = '';
  if (output) {
    if (output.length > 20000) {
      const head = output.slice(0, 2000);
      const tail = output.slice(-2000);
      body = `\n\n<pre>${escapeHtml(head)}\n\n... (${output.length} chars) ...\n\n${escapeHtml(tail)}</pre>`;
      await poller.sendDocument(
        Buffer.from(output, 'utf-8'),
        `result_${task.id}.txt`,
        `Full output for: ${task.text.slice(0, 100)}`
      );
    } else {
      body = `\n\n<pre>${escapeHtml(output)}</pre>`;
    }
  }

  // Try reply to original message (short header, task text visible in quote)
  const sentId = await poller.sendMessage(headerShort + body, task.telegramMessageId);
  if (!sentId && task.telegramMessageId) {
    // Reply failed — original message was deleted, send without reply but with full task text
    await poller.sendMessage(headerFull + body);
  }

  // Process next in queue
  const next = queue.onTaskComplete(workDir, output);
  if (next) {
    startTask(workDir, next);
  }
});

runner.on('error', async (workDir, task, errorMsg) => {
  stopLiveConsole(workDir);
  runner.cleanActivitySignal(workDir);
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);

  await poller.deleteMessage(task.runningMessageId);

  const body = `\n\n<pre>${escapeHtml(errorMsg)}</pre>`;
  const sentId = await poller.sendMessage(`❌  <code>${label}</code>\nError:${body}`, task.telegramMessageId);
  if (!sentId && task.telegramMessageId) {
    await poller.sendMessage(`❌  <code>${label}</code>\nError: ${escapeHtml(task.text)}${body}`);
  }

  const next = queue.onTaskComplete(workDir, `ERROR: ${errorMsg}`);
  if (next) {
    startTask(workDir, next);
  }
});

runner.on('timeout', async (workDir, task) => {
  stopLiveConsole(workDir);
  runner.cleanActivitySignal(workDir);
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);
  const timeoutMin = Math.round(taskTimeout / 60000);

  await poller.deleteMessage(task.runningMessageId);

  const headerShort = `⏰ <code>${label}</code>\nTask forcefully stopped — no activity for ${timeoutMin} min`;
  const headerFull = `${headerShort}: ${escapeHtml(task.text)}`;
  const sentId = await poller.sendMessage(headerShort, task.telegramMessageId);
  if (!sentId && task.telegramMessageId) {
    await poller.sendMessage(headerFull);
  }

  const next = queue.onTaskComplete(workDir, 'TIMEOUT');
  if (next) {
    startTask(workDir, next);
  }
});

// ----------------------
// HELPERS
// ----------------------

function formatLabel (entry) {
  if (!entry) {
    return 'unknown';
  }
  if (entry.branch && entry.branch !== 'main' && entry.branch !== 'master') {
    return `&${entry.project}/${entry.branch}`;
  }
  return `&${entry.project}`;
}

function getClaudeArgs (projectAlias) {
  const project = listenerConfig.projects[projectAlias];
  const projectArgs = (typeof project === 'object' && project.claudeArgs) || [];
  // Project-level args override global args
  return projectArgs.length > 0 ? projectArgs : globalClaudeArgs;
}

function shouldContinueSession (workDir) {
  if (!continueSessionEnabled) {
    return false;
  }
  if (freshSessionDirs.has(workDir)) {
    freshSessionDirs.delete(workDir);
    return false;
  }
  return sessions.has(workDir);
}

function _initJsonlReader (workDir) {
  const sessionId = runner.getSessionId(workDir);
  const jsonlPath = sessionId
    ? resolveJsonlPath(workDir, sessionId)
    : resolveJsonlByMtime(workDir);
  if (jsonlPath) {
    const reader = new JsonlReader(jsonlPath, logger);
    jsonlReaders.set(workDir, reader);
    logger.info(`JSONL reader initialized: ${jsonlPath}`);
    return reader;
  }
  return null;
}

function _getJsonlContent (workDir) {
  let reader = jsonlReaders.get(workDir);
  if (!reader) {
    reader = _initJsonlReader(workDir);
  }
  if (!reader) {
    return null;
  }
  reader.readNew();
  return reader.getDisplayContent(jsonlMaxContentChars);
}

function _getPtyContent (workDir) {
  const raw = runner.getBuffer(workDir);
  if (!raw) {
    return null;
  }
  const cleaned = cleanPtyOutput(raw);
  if (!cleaned) {
    return null;
  }
  const tail = cleaned.length > liveConsoleMaxOutputChars
    ? cleaned.slice(-liveConsoleMaxOutputChars)
    : cleaned;
  return cleaned.length > liveConsoleMaxOutputChars
    ? tail.slice(tail.indexOf('\n') + 1)
    : tail;
}

function startLiveConsole (workDir, messageId, header) {
  stopLiveConsole(workDir);
  if (!liveConsoleEnabled || !messageId) {
    return;
  }
  let lastSentText = '';
  const timer = setInterval(async () => {
    try {
      let output = null;
      if (liveConsoleSource === 'jsonl' || liveConsoleSource === 'auto') {
        output = _getJsonlContent(workDir);
      }
      if (!output && (liveConsoleSource === 'pty' || liveConsoleSource === 'auto')) {
        output = _getPtyContent(workDir);
      }
      if (!output || output === lastSentText) {
        return;
      }
      lastSentText = output;
      const elapsed = formatDuration(Date.now() - new Date(runner.getActive(workDir)?.startedAt || Date.now()).getTime());
      const activity = runner.getActivity(workDir);
      const activityLine = activity && (Date.now() - activity.timestamp < 30000)
        ? `\n<b>${escapeHtml(formatActivity(activity))}</b>`
        : '';
      const text = `${header}\n<i>${elapsed}</i>${activityLine}\n\n<pre>${escapeHtml(output)}</pre>`;
      await poller.editMessage(messageId, text);
    } catch (err) {
      logger.warn(`Live console edit error: ${err.message}`);
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
  const label = formatLabel(entry);
  const continueSession = shouldContinueSession(workDir);
  const session = sessions.get(workDir);

  // Raw slash-commands get a compact running message and skip the live console.
  if (task.raw) {
    const runningRaw = `📨 <code>${label}</code>  sending <code>${escapeHtml(task.text)}</code>…`;
    let runningMsgId = null;
    if (task.telegramMessageId) {
      runningMsgId = await poller.sendMessage(runningRaw, task.telegramMessageId);
    }
    if (!runningMsgId) {
      runningMsgId = await poller.sendMessage(runningRaw);
    }
    task.runningMessageId = runningMsgId;
    const claudeArgs = getClaudeArgs(entry?.project);
    try {
      runner.run(workDir, task, claudeArgs, continueSession);
      queue.markStarted(workDir, task.pid || 0);
    } catch (err) {
      logger.error(`Failed to start raw task: ${err.message}`);
      poller.sendMessage(`❌  <code>${label}</code>\nFailed to start: ${escapeHtml(err.message)}`);
      queue.onTaskComplete(workDir, `START_ERROR: ${err.message}`);
    }
    return;
  }

  // Build running message with session info
  let sessionTag = '';
  if (continueSession && session) {
    const ctxPart = session.lastContextPct ? `, ctx ${session.lastContextPct}%` : '';
    sessionTag = ` 🔄 #${session.taskCount + 1}${ctxPart}`;
  } else {
    sessionTag = ' 🆕';
  }

  const runningShort = `⏳ <code>${label}</code>${sessionTag}\nRunning...`;
  const runningFull = `⏳ <code>${label}</code>${sessionTag}\nRunning: ${escapeHtml(task.text)}`;
  let runningMsgId = null;

  if (task.telegramMessageId) {
    // In replies, the quoted user message already contains task text.
    runningMsgId = await poller.sendMessage(runningShort, task.telegramMessageId);
    if (!runningMsgId) {
      runningMsgId = await poller.sendMessage(runningFull);
    }
  } else {
    runningMsgId = await poller.sendMessage(runningFull);
  }

  task.runningMessageId = runningMsgId;
  startLiveConsole(workDir, runningMsgId, runningFull);
  const claudeArgs = getClaudeArgs(entry?.project);
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

async function handleCommand (cmd, args) {
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
      const label = s.branch && s.branch !== 'main' && s.branch !== 'master'
        ? `&${target.project}/${s.branch}`
        : `&${target.project}`;
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
      const label = s.branch && s.branch !== 'main' && s.branch !== 'master'
        ? `&${project}/${s.branch}`
        : `&${project}`;
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
      const label = s.branch && s.branch !== 'main' && s.branch !== 'master'
        ? `&${project}/${s.branch}`
        : `&${project}`;
      if (s.active || s.queueLength > 0) {
        text += `\n<b>${escapeHtml(label)}</b>:`;
        if (s.active) {
          text += `\n  ▶ ${escapeHtml(s.active.text)}`;
        }
        const entry = queue.queues[Object.keys(queue.queues).find(
          (wd) => queue.queues[wd].project === project && queue.queues[wd].branch === s.branch
        )];
        if (entry?.queue) {
          for (let i = 0; i < entry.queue.length; i++) {
            text += `\n  ${i + 1}. ${escapeHtml(entry.queue[i].text)}`;
          }
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

  if (!runner.isRunning(workDir)) {
    return `❌ No active task in &${escapeHtml(projectAlias)}${branch ? '/' + escapeHtml(branch) : ''}`;
  }

  runner.cancel(workDir);
  const next = queue.cancelActive(workDir);
  const label = branch ? `&${projectAlias}/${branch}` : `&${projectAlias}`;

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
  const label = branch ? `&${projectAlias}/${branch}` : `&${projectAlias}`;

  // Also reset session
  sessions.delete(workDir);
  freshSessionDirs.add(workDir);
  logger.info(`Session reset for ${workDir} via /clear`);

  return `🧹 [${escapeHtml(label)}] Queue cleared (${count} tasks), session reset`;
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

  const label = branch ? `&${projectAlias}/${branch}` : `&${projectAlias}`;
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
      return `🖥 No PTY session for &${escapeHtml(target.project)}${target.branch ? '/' + escapeHtml(target.branch) : ''}`;
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
  const label = branch && branch !== 'main' && branch !== 'master'
    ? `&${project}/${branch}`
    : `&${project}`;
  const elapsed = info.startedAt
    ? formatDuration(Date.now() - new Date(info.startedAt).getTime())
    : '-';
  const liveTimer = liveConsoleTimers.has(workDir) ? '✅' : '❌';
  const hasJsonl = jsonlReaders.has(workDir) ? '✅' : '❌';

  // Prefer JSONL content if available, fall back to PTY buffer
  let lastLines = '(empty)';
  const jsonlContent = _getJsonlContent(workDir);
  if (jsonlContent) {
    lastLines = jsonlContent.split('\n').slice(-15).join('\n');
  } else {
    const raw = runner.getBuffer(workDir);
    const cleaned = raw ? cleanPtyOutput(raw) : '';
    if (cleaned) {
      lastLines = cleaned.split('\n').slice(-15).join('\n');
    }
  }

  return `<b>${escapeHtml(label)}</b>
State: <code>${info.state}</code>
Buffer: <code>${info.bufferSize}</code> bytes
Elapsed: ${elapsed}
Live console: ${liveTimer}
JSONL source: ${hasJsonl}
PTY log: <code>${info.hasLogStream ? 'writing' : 'off'}</code>

<pre>${escapeHtml(lastLines)}</pre>`;
}

function handleHistory () {
  const history = queue.getHistory(10);
  if (history.length === 0) {
    return '📜 History is empty';
  }
  let text = '📜 <b>Recent tasks:</b>\n';
  for (const h of history.reverse()) {
    const label = h.branch && h.branch !== 'main' && h.branch !== 'master'
      ? `&${h.project}/${h.branch}`
      : `&${h.project}`;
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
    const label = formatLabel(entry);
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
          const response = await handleCommand(parsed.cmd, parsed.args);
          if (response) {
            if (typeof response === 'object' && response.text) {
              await poller.sendMessage(response.text, msg.callbackQueryId ? null : msg.messageId, response.replyMarkup);
            } else {
              await poller.sendMessage(response, msg.callbackQueryId ? null : msg.messageId);
            }
          }
        } else if (parsed.type === 'task') {
          logger.info(`Task for &${parsed.project}${parsed.branch ? '/' + parsed.branch : ''}: ${parsed.text}`);
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
    { command: 'help', description: 'Show all commands' },
    { command: 'stop', description: 'Stop listener' },
  ]);
  await mainLoop();
})();
