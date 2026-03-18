#!/usr/bin/env node

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const home = os.homedir();
const claudeDir = path.join(home, '.claude');
const configPath = path.join(claudeDir, 'notifier.config.json');
const settingsPath = path.join(claudeDir, 'settings.json');
const statePath = path.join(claudeDir, '.notifier_state.json');
const pidFile = path.join(claudeDir, '.listener.pid');

const HOOK_COMMAND = 'claude-notify';
const PLUGIN_KEY = 'claude-notification-plugin@bazilio-plugins';
const MARKETPLACE_KEY = 'bazilio-plugins';

function isPluginHookCommand (command) {
  if (typeof command !== 'string') {
    return false;
  }

  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized === HOOK_COMMAND || normalized.startsWith(`${HOOK_COMMAND} `);
}

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
      execSync(`taskkill /PID ${pid} /T /F`, {
        stdio: 'ignore',
        windowsHide: true,
      });
      console.log(`\x1b[33mListener process ${pid} killed\x1b[0m`);
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
    console.log(`\x1b[33mListener process ${pid} killed\x1b[0m`);
    return true;
  } catch {
    return false;
  }
}

function readPid (filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const pid = parseInt(fs.readFileSync(filePath, 'utf-8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removeFileIfExists (filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

function findListenerPids () {
  try {
    if (process.platform === 'win32') {
      const raw = execSync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress"',
        {
          encoding: 'utf-8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 10 * 1024 * 1024,
        },
      ).trim();

      if (!raw) {
        return [];
      }

      const rows = JSON.parse(raw);
      const processes = Array.isArray(rows) ? rows : [rows];
      return processes
        .filter((row) => /claude-notification-plugin[\\/]+listener[\\/]+listener\.js/i.test(row?.CommandLine || ''))
        .map((row) => Number(row?.ProcessId))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    }

    const raw = execSync('ps -eo pid=,args=', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = [];
    for (const line of raw.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+([\s\S]+)$/);
      if (!match) {
        continue;
      }

      const pid = parseInt(match[1], 10);
      const args = match[2];
      if (/claude-notification-plugin[\\/]+listener[\\/]+listener\.js/i.test(args)) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

function stopListenerIfRunning () {
  let stopped = false;
  const processed = new Set();

  const pidFromFile = readPid(pidFile);
  if (pidFromFile) {
    if (killProcessTree(pidFromFile)) {
      stopped = true;
    }
    processed.add(pidFromFile);
  }

  for (const pid of findListenerPids()) {
    if (processed.has(pid)) {
      continue;
    }
    if (killProcessTree(pid)) {
      stopped = true;
    }
  }

  removeFileIfExists(pidFile);
  return stopped;
}

console.log('\nUninstalling Claude Notification Plugin...\n');

// Stop listener daemon if running
stopListenerIfRunning();

// Remove hooks from settings.json
if (fs.existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    let hadPluginHooks = false;

    if (settings.hooks) {
      for (const event of Object.keys(settings.hooks)) {
        const eventHooks = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
        const hadInEvent = eventHooks.some((matcher) =>
          matcher.hooks?.some((h) => isPluginHookCommand(h.command)),
        );
        hadPluginHooks = hadPluginHooks || hadInEvent;

        settings.hooks[event] = settings.hooks[event].filter((matcher) =>
          !matcher.hooks?.some((h) => isPluginHookCommand(h.command)),
        );

        if (settings.hooks[event].length === 0) {
          delete settings.hooks[event];
        }
      }

      if (Object.keys(settings.hooks).length === 0) {
        delete settings.hooks;
      }
    }

    // Remove plugin from enabledPlugins
    if (settings.enabledPlugins?.[PLUGIN_KEY]) {
      delete settings.enabledPlugins[PLUGIN_KEY];
      if (Object.keys(settings.enabledPlugins).length === 0) {
        delete settings.enabledPlugins;
      }
    }

    // Remove marketplace from extraKnownMarketplaces
    if (settings.extraKnownMarketplaces?.[MARKETPLACE_KEY]) {
      delete settings.extraKnownMarketplaces[MARKETPLACE_KEY];
      if (Object.keys(settings.extraKnownMarketplaces).length === 0) {
        delete settings.extraKnownMarketplaces;
      }
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Verify hooks were actually removed
    const verify = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const remainingPluginHooks = verify.hooks
      ? Object.values(verify.hooks).some((matchers) =>
        Array.isArray(matchers) &&
        matchers.some((m) => m.hooks?.some((h) => isPluginHookCommand(h.command))),
      )
      : false;
    if (hadPluginHooks && !remainingPluginHooks) {
      console.log('Hooks removed from settings.json');
    } else if (hadPluginHooks && remainingPluginHooks) {
      console.warn('Warning: hooks still present in settings.json after removal attempt');
    }
  } catch (err) {
    console.error(`Error: failed to update settings.json: ${err.message}`);
  }
}

// Remove config, state, resolver, and listener files
const resolverPath = path.join(claudeDir, 'claude-notify-resolve.js');
const listenerLogFile = path.join(claudeDir, '.cc-n-listener.log');
for (const file of [configPath, statePath, resolverPath, pidFile, listenerLogFile]) {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`Removed ${path.basename(file)}`);
  }
}

// Remove CLI wrapper script
const WRAPPER_NAMES = ['claude-notify'];
const ext = process.platform === 'win32' ? '.cmd' : '';

// Collect directories to check for wrapper scripts
const wrapperDirs = new Set();

// Directory next to claude binary
try {
  const cmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  const claudeBin = execSync(cmd, { encoding: 'utf-8', windowsHide: true }).trim().split('\n')[0].trim();
  wrapperDirs.add(path.dirname(claudeBin));
} catch {
  // claude not in PATH
}

// ~/.local/bin (common on Linux/macOS, also used on Windows)
wrapperDirs.add(path.join(home, '.local', 'bin'));

for (const dir of wrapperDirs) {
  for (const name of WRAPPER_NAMES) {
    const filePath = path.join(dir, `${name}${ext}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Removed CLI wrapper: ${filePath}`);
    }
  }
}

// Remove from installed_plugins.json
const installedPluginsPath = path.join(claudeDir, 'plugins', 'installed_plugins.json');
if (fs.existsSync(installedPluginsPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
    if (data.plugins?.[PLUGIN_KEY]) {
      delete data.plugins[PLUGIN_KEY];
      fs.writeFileSync(installedPluginsPath, JSON.stringify(data, null, 2));
      console.log('Removed plugin from installed_plugins.json');
    }
  } catch {
    // ignore
  }
}

// Remove marketplace from known_marketplaces.json if no plugins reference it
const knownMarketplacesPath = path.join(claudeDir, 'plugins', 'known_marketplaces.json');
try {
  if (fs.existsSync(knownMarketplacesPath)) {
    // Check if any remaining plugins reference this marketplace
    let hasMarketplacePlugins = false;
    if (fs.existsSync(installedPluginsPath)) {
      const data = JSON.parse(fs.readFileSync(installedPluginsPath, 'utf-8'));
      if (data.plugins) {
        hasMarketplacePlugins = Object.keys(data.plugins)
          .some((key) => key.endsWith(`@${MARKETPLACE_KEY}`));
      }
    }

    if (!hasMarketplacePlugins) {
      const marketplaces = JSON.parse(fs.readFileSync(knownMarketplacesPath, 'utf-8'));
      if (marketplaces[MARKETPLACE_KEY]) {
        delete marketplaces[MARKETPLACE_KEY];
        fs.writeFileSync(knownMarketplacesPath, JSON.stringify(marketplaces, null, 2));
        console.log(`Removed marketplace "${MARKETPLACE_KEY}" from known_marketplaces.json`);
      }
      const marketplaceDir = path.join(claudeDir, 'plugins', 'marketplaces', MARKETPLACE_KEY);
      if (fs.existsSync(marketplaceDir)) {
        fs.rmSync(marketplaceDir, { recursive: true, force: true });
        console.log(`Removed marketplace directory: ${marketplaceDir}`);
      }
    }
  }
} catch {
  // ignore
}

// Remove plugin cache
const pluginCacheDir = path.join(claudeDir, 'plugins', 'cache', 'bazilio-plugins', 'claude-notification-plugin');
if (fs.existsSync(pluginCacheDir)) {
  fs.rmSync(pluginCacheDir, { recursive: true, force: true });
  if (fs.existsSync(pluginCacheDir)) {
    console.warn(`Warning: could not fully remove plugin cache directory:\n  ${pluginCacheDir}\nPlease remove it manually.`);
  } else {
    console.log('Removed plugin cache');
  }
}

console.log('\nDone.\n');

// If run manually (not via npm lifecycle), remove the global npm package too
if (!process.env.npm_lifecycle_event) {
  try {
    console.log('Removing npm global package...');
    execSync('npm uninstall -g claude-notification-plugin', {
      stdio: 'inherit',
      windowsHide: true,
    });
    console.log('');
  } catch {
    console.log('Could not remove npm package automatically.\nRun manually: npm uninstall -g claude-notification-plugin\n');
  }
}
