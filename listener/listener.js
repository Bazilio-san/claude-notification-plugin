#!/usr/bin/env node
// noinspection UnnecessaryLocalVariableJS

import fs from 'fs';
import path from 'path';
import process from 'process';
import { createLogger } from './logger.js';
import { createTaskLogger } from './task-logger.js';
import { TelegramPoller, escapeHtml } from './telegram-poller.js';
import { WorkQueue } from './work-queue.js';
import { TaskRunner } from './task-runner.js';
import { WorktreeManager } from './worktree-manager.js';
import { parseMessage, parseTarget } from './message-parser.js';
import { CLAUDE_DIR, CONFIG_PATH, LISTENER_LOG_FILENAME } from '../bin/constants.js';

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
const runner = new TaskRunner(logger, taskTimeout, taskLogger);
const worktreeManager = new WorktreeManager(config, logger);

const startTime = Date.now();

logger.info('Listener started');
logger.info(`Projects: ${JSON.stringify(Object.keys(listenerConfig.projects))}`);

// ----------------------
// DISCOVER WORKTREES ON START
// ----------------------

for (const alias of Object.keys(listenerConfig.projects)) {
  worktreeManager.discoverWorktrees(alias);
}

// ----------------------
// WATCHDOG
// ----------------------

const recovered = queue.watchdog(taskTimeout);
for (const { workDir, next } of recovered) {
  if (next) {
    startTask(workDir, next);
  }
}

// ----------------------
// TASK RUNNER EVENTS
// ----------------------

runner.on('complete', async (workDir, task, output) => {
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);

  // Delete the "Running" message
  await poller.deleteMessage(task.runningMessageId);

  // Build result: try replying to user's original message without duplicating the task text.
  // If reply fails (user deleted their message), resend with task text included.
  const headerShort = `✅ [${label}] Done:`;
  const headerFull = `✅ [${label}] Done: ${escapeHtml(task.text)}`;
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
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);

  await poller.deleteMessage(task.runningMessageId);

  const body = `\n\n<pre>${escapeHtml(errorMsg)}</pre>`;
  const sentId = await poller.sendMessage(`❌ [${label}] Error:${body}`, task.telegramMessageId);
  if (!sentId && task.telegramMessageId) {
    await poller.sendMessage(`❌ [${label}] Error: ${escapeHtml(task.text)}${body}`);
  }

  const next = queue.onTaskComplete(workDir, `ERROR: ${errorMsg}`);
  if (next) {
    startTask(workDir, next);
  }
});

runner.on('timeout', async (workDir, task) => {
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);
  const timeoutMin = Math.round(taskTimeout / 60000);

  await poller.deleteMessage(task.runningMessageId);

  const headerShort = `⏰ [${label}] Task forcefully stopped — timeout exceeded (${timeoutMin} min)`;
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
    return `@${entry.project}/${entry.branch}`;
  }
  return `@${entry.project}`;
}

async function startTask (workDir, task) {
  const entry = queue.queues[workDir];
  const label = formatLabel(entry);
  const runningShort = `⏳ [${label}] Running...`;
  const runningFull = `⏳ [${label}] Running: ${escapeHtml(task.text)}`;
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
  try {
    const started = runner.run(workDir, task);
    queue.markStarted(workDir, started.pid);
  } catch (err) {
    logger.error(`Failed to start task: ${err.message}`);
    poller.sendMessage(`❌ [${label}] Failed to start: ${escapeHtml(err.message)}`);
    queue.onTaskComplete(workDir, `START_ERROR: ${err.message}`);
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
    case '/projects':
      return handleProjects();
    case '/worktrees':
      return handleWorktrees(args);
    case '/worktree':
      return handleCreateWorktree(args);
    case '/rmworktree':
      return handleRemoveWorktree(args);
    case '/history':
      return handleHistory();
    case '/stop':
      return handleStop();
    case '/help':
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
    for (const s of statuses) {
      const branchLabel = s.branch || 'main';
      if (s.active) {
        const elapsed = s.active.startedAt
          ? formatDuration(Date.now() - new Date(s.active.startedAt).getTime())
          : '?';
        text += `\n<b>${escapeHtml(branchLabel)}</b>:\n`;
        text += `  ▶ ${escapeHtml(s.active.text)} (${elapsed})\n`;
        text += `  Queue: ${s.queueLength} tasks\n`;
      } else {
        text += `\n<b>${escapeHtml(branchLabel)}</b>: ✅ idle\n`;
        text += `  Queue: ${s.queueLength} tasks\n`;
      }
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
  for (const [project, statuses] of Object.entries(all)) {
    text += `\n<b>${escapeHtml(project)}</b>:`;
    for (const s of statuses) {
      const branchLabel = s.branch || 'main';
      if (s.active) {
        const elapsed = s.active.startedAt
          ? formatDuration(Date.now() - new Date(s.active.startedAt).getTime())
          : '?';
        text += `\n  ${escapeHtml(branchLabel)}: ▶ ${escapeHtml(s.active.text)} (${elapsed})`;
        if (s.queueLength > 0) {
          text += ` +${s.queueLength} queued`;
        }
      } else {
        text += `\n  ${escapeHtml(branchLabel)}: ✅ idle`;
      }
    }
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
        ? `@${project}/${s.branch}`
        : `@${project}`;
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
  const projectAlias = target?.project || 'default';
  const branch = target?.branch || null;

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(projectAlias, branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }

  if (!runner.isRunning(workDir)) {
    return `❌ No active task in @${escapeHtml(projectAlias)}${branch ? '/' + escapeHtml(branch) : ''}`;
  }

  runner.cancel(workDir);
  const next = queue.cancelActive(workDir);
  const label = branch ? `@${projectAlias}/${branch}` : `@${projectAlias}`;

  if (next) {
    startTask(workDir, next);
    return `🛑 [${escapeHtml(label)}] Task cancelled. Starting next.`;
  }
  return `🛑 [${escapeHtml(label)}] Task cancelled`;
}

function handleDrop (args) {
  const target = parseTarget(args);
  if (!target) {
    return '❌ Usage: /drop @project N';
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
  const projectAlias = target?.project || 'default';
  const branch = target?.branch || null;

  let workDir;
  try {
    workDir = worktreeManager.resolveWorkDir(projectAlias, branch);
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }

  const count = queue.clearQueue(workDir);
  const label = branch ? `@${projectAlias}/${branch}` : `@${projectAlias}`;
  return `🧹 [${escapeHtml(label)}] Queue cleared (${count} tasks)`;
}

function handleProjects () {
  const projects = listenerConfig.projects;
  let text = '📂 <b>Projects:</b>\n';
  for (const [alias, proj] of Object.entries(projects)) {
    const projPath = typeof proj === 'string' ? proj : proj.path;
    text += `\n<b>@${escapeHtml(alias)}</b> → <code>${escapeHtml(projPath)}</code>`;
    const worktrees = typeof proj === 'object' ? proj.worktrees : null;
    if (worktrees && Object.keys(worktrees).length > 0) {
      for (const [branch, wtPath] of Object.entries(worktrees)) {
        text += `\n  /${escapeHtml(branch)} → <code>${escapeHtml(wtPath)}</code>`;
      }
    }
  }
  return text;
}

function handleWorktrees (args) {
  const target = parseTarget(args);
  if (!target) {
    return '❌ Usage: /worktrees @project';
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
  if (!target || !target.rest) {
    return '❌ Usage: /worktree @project branch-name';
  }

  const branch = target.rest;
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
  if (!target || !target.rest) {
    return '❌ Usage: /rmworktree @project branch-name';
  }

  const branch = target.rest;

  // Check if there's an active task in this worktree
  let workDir;
  try {
    const project = listenerConfig.projects[target.project];
    workDir = project?.worktrees?.[branch];
  } catch {
    // ignore
  }

  if (workDir && runner.isRunning(workDir)) {
    return `❌ Cannot remove worktree: task is running. First /cancel @${escapeHtml(target.project)}/${escapeHtml(branch)}`;
  }

  try {
    worktreeManager.removeWorktree(target.project, branch);
    return `🗑 Worktree <b>${escapeHtml(branch)}</b> removed from "<b>${escapeHtml(target.project)}</b>"`;
  } catch (err) {
    return `❌ ${escapeHtml(err.message)}`;
  }
}

function handleHistory () {
  const history = queue.getHistory(10);
  if (history.length === 0) {
    return '📜 History is empty';
  }
  let text = '📜 <b>Recent tasks:</b>\n';
  for (const h of history.reverse()) {
    const label = h.branch && h.branch !== 'main' && h.branch !== 'master'
      ? `@${h.project}/${h.branch}`
      : `@${h.project}`;
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

function handleHelp () {
  return `<b>📖 Commands:</b>

/status — status of all projects
/status @project — project status
/queue — all queues
/cancel [@project[/branch]] — cancel task
/drop @project N — remove task from queue
/clear @project[/branch] — clear queue
/projects — list projects
/worktrees @project — project worktrees
/worktree @project branch — create worktree
/rmworktree @project branch — remove worktree
/history — task history
/stop — stop listener
/help — this help

<b>Tasks:</b>
<code>@project task</code> — main worktree
<code>@project/branch task</code> — worktree
<code>task</code> — default project`;
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
    logger.info(`Auto-created worktree for task: @${parsed.project}/${parsed.branch} → ${workDir}`);
  }

  const result = queue.enqueue(
    workDir,
    parsed.project,
    parsed.branch || 'main',
    parsed.text,
    telegramMessageId,
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
  runner.cancelAll();
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGINT', () => {
  logger.info('Received SIGINT');
  running = false;
  runner.cancelAll();
  setTimeout(() => process.exit(0), 2000);
});

async function mainLoop () {
  while (running) {
    try {
      const messages = await poller.getUpdates();
      for (const msg of messages) {
        const parsed = parseMessage(msg.text);
        if (!parsed) {
          continue;
        }

        if (parsed.type === 'command') {
          logger.info(`Command: ${parsed.cmd} ${parsed.args}`);
          const response = await handleCommand(parsed.cmd, parsed.args);
          if (response) {
            await poller.sendMessage(response, msg.messageId);
          }
        } else if (parsed.type === 'task') {
          logger.info(`Task for @${parsed.project}${parsed.branch ? '/' + parsed.branch : ''}: ${parsed.text}`);
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
  await mainLoop();
})();
