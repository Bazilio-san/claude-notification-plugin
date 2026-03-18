#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_LOG_DIR = path.join(os.homedir(), '.claude');
const PID_FILE = path.join(os.homedir(), '.claude', '.listener.pid');
const CONFIG_FILE = path.join(os.homedir(), '.claude', 'notifier.config.json');

function getLogFile () {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const logDir = cfg.listener?.logDir || DEFAULT_LOG_DIR;
    return path.join(logDir, '.cc-n-listener.log');
  } catch {
    return path.join(DEFAULT_LOG_DIR, '.cc-n-listener.log');
  }
}
const LISTENER_SCRIPT = path.join(__dirname, '..', 'listener', 'listener.js');

const command = process.argv[2];

switch (command) {
  case 'start':
    startDaemon();
    break;
  case 'stop':
    stopDaemon();
    break;
  case 'status':
    showStatus();
    break;
  case 'logs':
    showLogs();
    break;
  case 'restart':
    stopDaemon();
    setTimeout(() => startDaemon(), 1000);
    break;
  case 'setup':
    setupListener();
    break;
  default:
    console.log(`Usage: claude-notify listener <start|stop|status|setup|logs|restart>

Commands:
  start    Start the listener daemon
  stop     Stop the listener daemon
  status   Show daemon status
  setup    Interactive listener configuration
  logs     Show recent log entries
  restart  Restart the daemon`);
    process.exit(command ? 1 : 0);
}

function startDaemon () {
  // Check if already running
  const existingPid = readPid();
  if (existingPid && isProcessAlive(existingPid)) {
    console.log(`Listener is already running (PID: ${existingPid})`);
    process.exit(1);
  }

  // Clean stale PID file
  if (existingPid) {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }

  // Validate config
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`Config not found: ${CONFIG_FILE}`);
    console.error('Run claude-notify install first, or create the config manually.');
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    console.error(`Invalid config: ${err.message}`);
    process.exit(1);
  }

  const token = process.env.CLAUDE_NOTIFY_TELEGRAM_TOKEN || config.telegramToken || config.telegram?.token;
  const chatId = process.env.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID || config.telegramChatId || config.telegram?.chatId;

  if (!token || !chatId) {
    console.error('Missing telegramToken or telegramChatId in config.');
    console.error('These are required for the listener to receive messages.');
    process.exit(1);
  }

  if (!config.listener?.projects || Object.keys(config.listener.projects).length === 0) {
    console.error('No projects defined in config.listener.projects');
    console.error('');
    console.error('Add projects to your config:');
    console.error(JSON.stringify({
      listener: {
        projects: {
          default: { path: '/path/to/your/project' },
        },
      },
    }, null, 2));
    process.exit(1);
  }

  // Ensure log directory exists
  const logFile = getLogFile();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  // Open log file for child stdio
  const logFd = fs.openSync(logFile, 'a');

  // Spawn detached child
  const child = spawn(process.execPath, [LISTENER_SCRIPT], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(logFd);

  // Write PID
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(child.pid));

  console.log(`Listener started (PID: ${child.pid})
Log: ${logFile}
Projects: ${Object.keys(config.listener.projects).join(', ')}`);
}

function stopDaemon () {
  const pid = readPid();
  if (!pid) {
    console.log('Listener is not running (no PID file)');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Listener is not running (stale PID: ${pid})`);
    cleanPid();
    return;
  }

  console.log(`Stopping listener (PID: ${pid})...`);

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGTERM');
      // Wait for graceful shutdown
      let tries = 10;
      while (tries-- > 0 && isProcessAlive(pid)) {
        execSync('sleep 0.5', { stdio: 'ignore' });
      }
      if (isProcessAlive(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    // Process may already be dead
  }

  cleanPid();
  console.log('Listener stopped');
}

function showStatus () {
  const pid = readPid();
  if (!pid) {
    console.log('Status: not running');
    return;
  }

  if (!isProcessAlive(pid)) {
    console.log(`Status: not running (stale PID: ${pid})`);
    cleanPid();
    return;
  }

  const logFile = getLogFile();
  console.log(`Status: running (PID: ${pid})
Log: ${logFile}`);

  // Show last few log lines
  try {
    if (fs.existsSync(logFile)) {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.trim().split('\n');
      const last = lines.slice(-5);
      console.log('\nRecent log:');
      for (const line of last) {
        console.log(`  ${line}`);
      }
    }
  } catch {
    // ignore
  }
}

function showLogs () {
  const logFile = getLogFile();
  try {
    if (!fs.existsSync(logFile)) {
      console.log('No log file found');
      return;
    }
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n');
    const last = lines.slice(-50);
    for (const line of last) {
      console.log(line);
    }
  } catch (err) {
    console.error(`Failed to read log: ${err.message}`);
  }
}

function readPid () {
  try {
    if (fs.existsSync(PID_FILE)) {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    // ignore
  }
  return null;
}

function cleanPid () {
  try {
    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    // ignore
  }
}

function isProcessAlive (pid) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`tasklist /FI "PID eq ${pid}" /NH`, {
        encoding: 'utf-8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      return result.includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ask (rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

function askYesNo (rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}

function isValidPath (p) {
  if (!p || p.includes('\0')) {
    return false;
  }
  try {
    path.resolve(p);
    return true;
  } catch {
    return false;
  }
}

function ensureDir (dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return fs.existsSync(dirPath);
  } catch {
    return false;
  }
}

function isValidAlias (alias) {
  return /^[a-zA-Z0-9_-]+$/.test(alias);
}

function parsePositiveInt (str, fallback) {
  if (!str) {
    return fallback;
  }
  const n = parseInt(str, 10);
  if (isNaN(n) || n <= 0) {
    console.log(`  \u26a0 Invalid value "${str}". Using default: ${fallback}`);
    return fallback;
  }
  return n;
}

function validateDir (inputPath, defaultPath) {
  const chosen = inputPath || defaultPath;
  if (!isValidPath(chosen)) {
    console.log(`  \u26a0 Invalid path "${chosen}". Using default: ${defaultPath}`);
    if (!ensureDir(defaultPath)) {
      console.log(`  \u26a0 Cannot create "${defaultPath}". Please check permissions.`);
    }
    return defaultPath;
  }
  if (!ensureDir(chosen)) {
    console.log(`  \u26a0 Cannot create "${chosen}". Using default: ${defaultPath}`);
    ensureDir(defaultPath);
    return defaultPath;
  }
  return chosen;
}

async function validateProjectPath (rl, inputPath) {
  if (!inputPath) {
    return null;
  }
  if (!isValidPath(inputPath)) {
    console.log('  \u26a0 Invalid path. Project will not be set.');
    return null;
  }
  const resolved = path.resolve(inputPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return resolved;
  }
  const create = await askYesNo(rl, `  Directory "${resolved}" does not exist. Create it? (y/n): `);
  if (create) {
    if (ensureDir(resolved)) {
      return resolved;
    }
    console.log(`  \u26a0 Cannot create "${resolved}".`);
  }
  return null;
}

async function setupListener () {
  let config = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {
      // ignore
    }
  }

  config.listener = config.listener || {};
  const L = config.listener;
  const home = os.homedir();

  const defaults = {
    worktreeBaseDir: L.worktreeBaseDir || path.join(home, '.claude', 'worktrees'),
    taskTimeoutMinutes: L.taskTimeoutMinutes ?? 30,
    maxQueuePerWorkDir: L.maxQueuePerWorkDir ?? 10,
    maxTotalTasks: L.maxTotalTasks ?? 50,
    logDir: L.logDir || path.join(home, '.claude'),
    taskLogDir: L.taskLogDir || path.join(home, '.claude'),
    projectPath: L.projects?.default?.path || '',
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`
Listener Setup
==============
Press Enter to keep current value shown in [brackets].
`);

  // --- Directories ---
  const worktreeInput = await ask(rl, `Worktree base dir [${defaults.worktreeBaseDir}]: `);
  L.worktreeBaseDir = validateDir(worktreeInput, defaults.worktreeBaseDir);

  const logDirInput = await ask(rl, `Log dir [${defaults.logDir}]: `);
  L.logDir = validateDir(logDirInput, defaults.logDir);

  const taskLogDirInput = await ask(rl, `Task log dir [${defaults.taskLogDir}]: `);
  L.taskLogDir = validateDir(taskLogDirInput, defaults.taskLogDir);

  // --- Numeric params ---
  const taskTimeoutStr = await ask(rl, `Task timeout, minutes [${defaults.taskTimeoutMinutes}]: `);
  L.taskTimeoutMinutes = parsePositiveInt(taskTimeoutStr, defaults.taskTimeoutMinutes);

  const maxQueueStr = await ask(rl, `Max queue per work dir [${defaults.maxQueuePerWorkDir}]: `);
  L.maxQueuePerWorkDir = parsePositiveInt(maxQueueStr, defaults.maxQueuePerWorkDir);

  const maxTotalStr = await ask(rl, `Max total tasks [${defaults.maxTotalTasks}]: `);
  L.maxTotalTasks = parsePositiveInt(maxTotalStr, defaults.maxTotalTasks);

  // --- Default project ---
  console.log('');
  const projectInput = await ask(rl, `Default project path [${defaults.projectPath || '(none)'}]: `);
  const rawProjectPath = projectInput || defaults.projectPath;

  L.projects = L.projects || {};
  let hasValidProject = false;

  if (rawProjectPath) {
    const validatedPath = await validateProjectPath(rl, rawProjectPath);
    if (validatedPath) {
      L.projects.default = L.projects.default || {};
      L.projects.default.path = validatedPath;
      hasValidProject = true;
    } else {
      delete L.projects.default;
      console.log('  \u26a0 Default project will not be set. Listener will not start without at least one project.');
    }
  } else {
    delete L.projects.default;
    console.log('  \u26a0 No default project configured. Listener will not start without at least one project.');
  }

  // --- Additional projects loop ---
  // Count existing non-default projects
  const existingAliases = Object.keys(L.projects).filter(a => a !== 'default');
  if (existingAliases.length > 0) {
    console.log(`\nExisting projects: ${existingAliases.join(', ')}`);
  }

  while (true) {
    console.log('');
    const addMore = await askYesNo(rl, 'Add another project? (y/n): ');
    if (!addMore) {
      break;
    }

    // Ask alias with validation loop
    let alias = '';
    while (true) {
      alias = await ask(rl, 'Project alias: ');
      if (!alias) {
        console.log('  \u26a0 Alias cannot be empty.');
        continue;
      }
      if (alias === 'default') {
        console.log('  \u26a0 "default" is reserved. Choose a different name.');
        continue;
      }
      if (!isValidAlias(alias)) {
        console.log('  \u26a0 Invalid alias. Allowed characters: a-z, A-Z, 0-9, -, _');
        continue;
      }
      if (L.projects[alias]) {
        console.log(`  \u26a0 Alias "${alias}" already exists. Choose a different name.`);
        continue;
      }
      break;
    }

    // Ask path with validation
    const projPathInput = await ask(rl, `Project path for "${alias}": `);
    if (!projPathInput) {
      console.log(`  \u26a0 Project "${alias}" was not added (no path provided).`);
      continue;
    }

    const validatedProjPath = await validateProjectPath(rl, projPathInput);
    if (validatedProjPath) {
      L.projects[alias] = { path: validatedProjPath };
      hasValidProject = true;
      console.log(`  \u2713 Project "${alias}" added: ${validatedProjPath}`);
    } else {
      console.log(`  \u26a0 Project "${alias}" was not added (invalid path).`);
    }
  }

  rl.close();

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  const projectCount = Object.keys(L.projects).length;
  console.log(`\nListener config saved to ${CONFIG_FILE}`);
  if (hasValidProject || projectCount > 0) {
    console.log('Run "claude-notify listener start" to apply.');
  } else {
    console.log('\u26a0 No projects configured. Listener will not start until at least one project is added.');
    console.log('Run "claude-notify listener setup" again to add projects.');
  }
  console.log('');
}
