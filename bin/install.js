#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const pluginsDir = path.join(claudeDir, 'plugins');
const configPath = path.join(claudeDir, 'notifier.config.json');
const settingsPath = path.join(claudeDir, 'settings.json');
const installedPluginsPath = path.join(pluginsDir, 'installed_plugins.json');
const knownMarketplacesPath = path.join(pluginsDir, 'known_marketplaces.json');
const marketplacesDir = path.join(pluginsDir, 'marketplaces');
const RESOLVER_PATH = path.join(claudeDir, 'claude-notify-resolve.js');
const pidFile = path.join(claudeDir, '.listener.pid');
const installLogPath = path.join(claudeDir, 'claude-notify-install.log');

// ──────────────────────────────────────
// Logging to file
// ──────────────────────────────────────

let logStream;

function initLog () {
  fs.mkdirSync(claudeDir, { recursive: true });
  logStream = fs.createWriteStream(installLogPath, { flags: 'w' });
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const stamp = () => new Date().toISOString();

  console.log = (...args) => {
    origLog(...args);
    const line = args.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    logStream.write(`[${stamp()}] ${line}\n`);
  };

  console.warn = (...args) => {
    origWarn(...args);
    const line = args.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    logStream.write(`[${stamp()}] WARN: ${line}\n`);
  };
}

function closeLog () {
  if (logStream) {
    logStream.end();
  }
}

// ──────────────────────────────────────
// Stop listener before reinstall
// ──────────────────────────────────────

function isProcessAlive (pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
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

function killProcessTree (pid) {
  if (!isProcessAlive(pid)) {
    return false;
  }
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
      console.log(`  Listener process ${pid} killed`);
      return true;
    }
    process.kill(pid, 'SIGTERM');
    let tries = 10;
    while (tries-- > 0 && isProcessAlive(pid)) {
      execSync('sleep 0.2', { stdio: 'ignore' });
    }
    if (isProcessAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    console.log(`  Listener process ${pid} killed`);
    return true;
  } catch {
    return false;
  }
}

function stopListenerIfRunning () {
  let stopped = false;
  const pidFromFile = (() => {
    try {
      if (!fs.existsSync(pidFile)) {
        return null;
      }
      const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null; 
    }
  })();

  if (pidFromFile && killProcessTree(pidFromFile)) {
    stopped = true;
  }

  try {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch { /* ignore */ }

  return stopped;
}

const HOOK_COMMAND = 'claude-notify';
const MARKETPLACE_KEY = 'bazilio-plugins';
const PLUGIN_KEY = 'claude-notification-plugin@bazilio-plugins';
const MARKETPLACE_REPO = 'https://github.com/Bazilio-san/claude-plugins.git';
const MARKETPLACE_GITHUB = 'Bazilio-san/claude-plugins';

const CLI_BIN_NAME = 'claude-notify';
const CLI_BIN_TARGET = 'bin/cli.js';

// ──────────────────────────────────────
// Plugin registration
// ──────────────────────────────────────

function getVersion () {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
  return pkg.version;
}

function readCommitSha () {
  const shaFile = path.join(PACKAGE_ROOT, 'commit-sha');
  try {
    return fs.readFileSync(shaFile, 'utf-8').trim();
  } catch {
    return '';
  }
}

function copyToCache (version) {
  const cacheBase = path.join(pluginsDir, 'cache', MARKETPLACE_KEY, 'claude-notification-plugin');
  const dest = path.join(cacheBase, version);

  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
  const entries = [...(pkg.files || []), 'package.json', 'package-lock.json'];

  for (const entry of entries) {
    const src = path.join(PACKAGE_ROOT, entry);
    if (!fs.existsSync(src)) {
      continue;
    }
    const target = path.join(dest, entry);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      fs.cpSync(src, target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(src, target);
    }
  }

  try {
    const env = { ...process.env };
    delete env.npm_config_global;
    delete env.npm_config_prefix;
    execSync('npm install --omit=dev --ignore-scripts', {
      cwd: dest,
      stdio: 'pipe',
      windowsHide: true,
      env,
    });
  } catch (err) {
    console.warn('  Warning: could not install dependencies in plugin cache.');
    console.warn('  Reason:', err.stderr?.toString?.() || err.message);
  }

  return dest;
}

function updateInstalledPlugins (version, installPath) {
  fs.mkdirSync(pluginsDir, { recursive: true });

  let data = { version: 2, plugins: {} };
  if (fs.existsSync(installedPluginsPath)) {
    try {
      data = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
    } catch {
      // ignore malformed file
    }
  }

  const now = new Date().toISOString();
  const existing = data.plugins[PLUGIN_KEY]?.[0];

  data.plugins[PLUGIN_KEY] = [{
    scope: 'user',
    installPath,
    version,
    installedAt: existing?.installedAt || now,
    lastUpdated: now,
    gitCommitSha: readCommitSha(),
  }];

  fs.writeFileSync(installedPluginsPath, JSON.stringify(data, null, 2));
}

function updateKnownMarketplaces () {
  let data = {};
  if (fs.existsSync(knownMarketplacesPath)) {
    try {
      data = JSON.parse(fs.readFileSync(knownMarketplacesPath, 'utf-8'));
    } catch {
      // ignore malformed file
    }
  }

  const installLocation = path.join(marketplacesDir, MARKETPLACE_KEY);

  data[MARKETPLACE_KEY] = {
    ...data[MARKETPLACE_KEY],
    source: {
      source: 'github',
      repo: MARKETPLACE_GITHUB,
    },
    installLocation,
    lastUpdated: data[MARKETPLACE_KEY]?.lastUpdated || new Date().toISOString(),
    autoUpdate: true,
  };

  fs.writeFileSync(knownMarketplacesPath, JSON.stringify(data, null, 2));
}

function cloneOrUpdateMarketplace () {
  const dest = path.join(marketplacesDir, MARKETPLACE_KEY);

  if (fs.existsSync(path.join(dest, '.git'))) {
    try {
      execSync('git pull --ff-only', { cwd: dest, stdio: 'pipe', windowsHide: true });
    } catch {
      // offline or conflict — not fatal
    }
  } else {
    fs.mkdirSync(marketplacesDir, { recursive: true });
    try {
      execSync(`git clone "${MARKETPLACE_REPO}" "${dest}"`, {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      console.warn('  Warning: could not clone marketplace repo (offline?).');
    }
  }
}

// ──────────────────────────────────────
// CLI wrapper registration
// ──────────────────────────────────────

function writeResolver () {
  const content = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pluginKey = 'claude-notification-plugin@bazilio-plugins';
const home = process.env.USERPROFILE || process.env.HOME;
const regPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');

let installPath;
try {
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
  const entries = reg.plugins[pluginKey];
  if (entries && entries.length) installPath = entries[0].installPath;
} catch {}

if (!installPath) {
  console.error('claude-notification-plugin is not installed.');
  process.exit(1);
}

const target = path.join(installPath, process.argv[2]);
const args = process.argv.slice(3);

try {
  execFileSync('node', [target, ...args], { stdio: 'inherit' });
} catch (e) {
  process.exit(e.status || 1);
}
`;
  fs.writeFileSync(RESOLVER_PATH, content, { mode: 0o755 });
}

function findClaudeDir () {
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
    const result = execSync(cmd, { encoding: 'utf-8', windowsHide: true }).trim();
    const first = result.split('\n')[0].trim();
    return path.dirname(first);
  } catch {
    return null;
  }
}

function registerCli () {
  const binDir = findClaudeDir();
  if (!binDir) {
    console.warn('  Warning: "claude" not found in PATH — CLI wrappers not registered.');
    return;
  }

  writeResolver();

  const isWindows = process.platform === 'win32';
  const resolverNative = RESOLVER_PATH.replace(/\//g, path.sep);
  let wrapperPath;

  if (isWindows) {
    wrapperPath = path.join(binDir, `${CLI_BIN_NAME}.cmd`);
    const content = `@echo off\r\nnode "${resolverNative}" ${CLI_BIN_TARGET} %*\r\n`;
    fs.writeFileSync(wrapperPath, content);
  } else {
    wrapperPath = path.join(binDir, CLI_BIN_NAME);
    const content = `#!/bin/sh\nexec node "${RESOLVER_PATH}" "${CLI_BIN_TARGET}" "$@"\n`;
    fs.writeFileSync(wrapperPath, content, { mode: 0o755 });
  }

  console.log(`  CLI wrapper registered: ${wrapperPath}`);
}

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

function openTtyInput () {
  // If stdin is already a TTY (e.g. local `npm install`), use it directly
  if (process.stdin.isTTY) {
    return process.stdin;
  }
  // On Unix, try opening /dev/tty directly (works even when npm pipes stdin)
  if (process.platform !== 'win32') {
    try {
      const fd = fs.openSync('/dev/tty', 'r');
      return fs.createReadStream(null, { fd, encoding: 'utf-8' });
    } catch {
      // no TTY available (CI/CD, Docker, etc.)
    }
  }
  return null;
}

function ask (rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function fetchChatId (token) {
  const url = `https://api.telegram.org/bot${token}/getUpdates`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (!data.ok || !data.result?.length) {
      return null;
    }

    const msg = data.result[data.result.length - 1].message;
    if (msg?.chat?.id) {
      return String(msg.chat.id);
    }
  } catch {
    // silent fail
  }

  return null;
}

function removeHook (settings, event) {
  if (!settings.hooks[event]) {
    return;
  }
  settings.hooks[event] = settings.hooks[event].filter((matcher) =>
    !matcher.hooks?.some((h) => h.command?.includes(HOOK_COMMAND)),
  );
  if (settings.hooks[event].length === 0) {
    delete settings.hooks[event];
  }
}

// ──────────────────────────────────────
// Main
// ──────────────────────────────────────

async function main () {
  initLog();

  // 0. Stop listener if running (before overwriting files)
  const listenerWasStopped = stopListenerIfRunning();

  // 1. Register plugin in Claude Code
  const version = getVersion();

  console.log('');
  console.log(`Registering plugin v${version} in Claude Code...`);

  const installPath = copyToCache(version);
  console.log(`  Cached: ${installPath}`);

  updateInstalledPlugins(version, installPath);
  console.log('  Updated installed_plugins.json');

  updateKnownMarketplaces();
  console.log('  Updated known_marketplaces.json');

  cloneOrUpdateMarketplace();
  console.log('  Marketplace synced');

  registerCli();

  console.log('  Plugin registered.');

  // 2. Interactive Telegram setup
  let existing = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // ignore malformed config
    }
  }

  const existingToken = existing.telegram?.token || '';
  const existingChatId = existing.telegram?.chatId || '';

  let token = existingToken;
  let chatId = existingChatId;

  const ttyInput = openTtyInput();
  if (ttyInput) {
    const rl = readline.createInterface({
      input: ttyInput,
      output: process.stdout,
    });

    console.log(`
Claude Notification Plugin - Setup
==================================
`);

    if (existingToken) {
      const masked = existingToken.slice(0, 6) + '...' + existingToken.slice(-4);
      console.log(`Telegram token found: ${masked}`);
      const reuse = await ask(rl, 'Keep existing token? (Y/n): ');
      if (reuse.toLowerCase() === 'n') {
        token = await ask(rl, 'New Bot Token: ');
        chatId = '';
      }
    } else {
      const useTelegram = await ask(rl, 'Configure Telegram? (y/N): ');
      if (useTelegram.toLowerCase() === 'y') {
        token = await ask(rl, 'Bot Token: ');
      }
    }

    if (token && !chatId) {
      console.log(`\x1b[32m
Send any message to your bot in Telegram, then press Enter.\x1b[0m`);
      await ask(rl, '');

      console.log('Fetching Chat ID...');
      chatId = await fetchChatId(token);

      if (chatId) {
        console.log('Chat ID detected: ' + chatId);
      } else {
        console.log('Could not detect Chat ID automatically.');
        chatId = await ask(rl, 'Enter Chat ID manually: ');
      }
    } else if (token && chatId) {
      console.log(`Chat ID: ${chatId}`);
    }

    rl.close();
    if (ttyInput !== process.stdin) {
      ttyInput.destroy();
    }
  } else {
    const telegramMsg = token && chatId
      ? 'Telegram: using existing config.'
      : 'Interactive setup skipped. Run "claude-notify install" to configure.';
    console.log(`\nNon-interactive install (stdin is not a terminal).\n${telegramMsg}`);
  }

  // 3. Write config
  fs.mkdirSync(claudeDir, { recursive: true });

  const platform = process.platform;
  let defaultSoundFile;
  switch (platform) {
    case 'darwin': defaultSoundFile = '/System/Library/Sounds/Glass.aiff'; break;
    case 'linux': defaultSoundFile = '/usr/share/sounds/freedesktop/stereo/complete.oga'; break;
    default: defaultSoundFile = 'C:/Windows/Media/notify.wav';
  }

  const defaults = {
    telegram: {
      enabled: true,
      token: '',
      chatId: '',
      deleteAfterHours: 24,
    },
    desktopNotification: {
      enabled: true,
    },
    sound: {
      enabled: true,
      file: defaultSoundFile,
    },
    voice: {
      enabled: true,
    },
    webhookUrl: '',
    sendUserPromptToWebhook: false,
    notifyAfterSeconds: 15,
    notifyOnWaiting: false,
    debug: false,
    listener: {
      projects: {},
      worktreeBaseDir: path.join(home, '.claude', 'worktrees'),
      autoCreateWorktree: true,
      taskTimeoutMinutes: 30,
      maxQueuePerWorkDir: 10,
      maxTotalTasks: 50,
      logDir: '',
      taskLogDir: '',
    },
  };

  const config = { ...defaults, ...existing };
  for (const key of Object.keys(defaults)) {
    if (defaults[key] && typeof defaults[key] === 'object' && !Array.isArray(defaults[key])) {
      config[key] = { ...defaults[key], ...(existing[key] || {}) };
    }
  }

  if (token) {
    config.telegram.token = token;
  }
  if (chatId) {
    config.telegram.chatId = chatId;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // 4. Register hooks
  let settings = {};

  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  // Register plugin as enabled
  settings.enabledPlugins = settings.enabledPlugins || {};
  settings.enabledPlugins[PLUGIN_KEY] = true;

  // When the plugin is enabled, Claude Code loads hooks from hooks/hooks.json automatically.
  // Remove any duplicate hooks from settings.json to avoid double notifications.
  settings.hooks = settings.hooks || {};
  removeHook(settings, 'UserPromptSubmit');
  removeHook(settings, 'Stop');
  removeHook(settings, 'Notification');

  // Register marketplace
  settings.extraKnownMarketplaces = settings.extraKnownMarketplaces || {};
  settings.extraKnownMarketplaces[MARKETPLACE_KEY] = {
    source: {
      source: 'github',
      repo: MARKETPLACE_GITHUB,
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // 5. Summary
  const telegramStatus = config.telegram.token && config.telegram.chatId
    ? 'Telegram: configured'
    : 'Telegram: not configured (edit config later)';

  let platformTip = '';
  if (platform === 'darwin') {
    platformTip = `\nTip: install terminal-notifier for better macOS notifications:
  brew install terminal-notifier`;
  } else if (platform === 'linux') {
    platformTip = `\nTip: for voice announcements, install espeak:
  sudo apt install espeak`;
  }

  const listenerLine = listenerWasStopped ? '\nListener was stopped (restart manually if needed).' : '';

  console.log(`
Installed!
${listenerLine}
Plugin hooks (via hooks/hooks.json):
  - UserPromptSubmit (start timer)
  - Stop (task finished)
  - Notification (waiting for input)

Config: ${configPath}
${telegramStatus}${platformTip}

Log: ${installLogPath}

To uninstall:  claude-notify uninstall

To disable per project, add to .claude/settings.local.json: { "env": { "CLAUDE_NOTIFY_DISABLE": "1" } }`);

  closeLog();
}

// Skip postinstall for local (non-global) npm installs
const isGlobal = process.env.npm_config_global === 'true'
  || process.env.npm_lifecycle_event !== 'postinstall';
if (process.env.npm_lifecycle_event === 'postinstall' && !isGlobal) {
  console.log('claude-notification-plugin: skipping postinstall (local install detected)');
  process.exit(0);
}

main().then(() => 0);
