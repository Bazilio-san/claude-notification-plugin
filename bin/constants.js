import fs from 'fs';
import os from 'os';
import path from 'path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

// File names
export const CONFIG_FILENAME = 'claude-notify.config.json';
export const SEEN_PROJECTS_FILENAME = 'claude-notify.seen.json';
export const STATE_FILENAME = '.notifier_state.json';
export const PID_FILENAME = '.listener.pid';
export const RESOLVER_FILENAME = 'claude-notify-resolve.js';
export const LISTENER_LOG_FILENAME = '.cc-n-listener.log';
export const INSTALL_LOG_FILENAME = 'claude-notify-install.log';

// PTY signal directory
export const PTY_SIGNAL_DIR = path.join(CLAUDE_DIR, 'pty-signals');

// Full paths
export const CONFIG_PATH = path.join(CLAUDE_DIR, CONFIG_FILENAME);
export const SEEN_PROJECTS_PATH = path.join(CLAUDE_DIR, SEEN_PROJECTS_FILENAME);
export const MAX_SEEN_ENTRIES = 30;
export const STATE_PATH = path.join(CLAUDE_DIR, STATE_FILENAME);
export const PID_PATH = path.join(CLAUDE_DIR, PID_FILENAME);
export const RESOLVER_PATH = path.join(CLAUDE_DIR, RESOLVER_FILENAME);
export const LISTENER_LOG_PATH = path.join(CLAUDE_DIR, LISTENER_LOG_FILENAME);
export const INSTALL_LOG_PATH = path.join(CLAUDE_DIR, INSTALL_LOG_FILENAME);
export const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
export const INSTALLED_PLUGINS_PATH = path.join(PLUGINS_DIR, 'installed_plugins.json');
export const KNOWN_MARKETPLACES_PATH = path.join(PLUGINS_DIR, 'known_marketplaces.json');
export const MARKETPLACES_DIR = path.join(PLUGINS_DIR, 'marketplaces');

// Windows notification shortcut
export const ICO_FILENAME = 'claude-notify.ico';
export const ICO_PATH = path.join(CLAUDE_DIR, ICO_FILENAME);
export const SHORTCUT_NAME = 'Claude Notify.lnk';
export const SHORTCUT_DIR = path.join(
  process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs'
);
export const SHORTCUT_PATH = path.join(SHORTCUT_DIR, SHORTCUT_NAME);
export const APP_ID = 'Claude Notify';

/**
 * Find the alias of the project marked as default (isDefault: true).
 * Falls back to the first project key if none is marked.
 */
export function getDefaultProject (projects) {
  if (!projects || typeof projects !== 'object') {
    return null;
  }
  for (const [alias, proj] of Object.entries(projects)) {
    if (typeof proj === 'object' && proj.isDefault) {
      return alias;
    }
  }
  // Fallback: first project
  const keys = Object.keys(projects);
  return keys.length > 0 ? keys[0] : null;
}

/**
 * Save config object back to CONFIG_PATH.
 */
export function saveConfig (config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Normalize a filesystem path for equality comparison.
 * - Resolves ".", "..", trailing slashes, mixed separators.
 * - Uses forward slashes.
 * - Lowercases on Windows (case-insensitive FS).
 */
export function normalizeForCompare (p) {
  if (!p) {
    return '';
  }
  const resolved = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Load the seen-projects file. Returns { entries: [] } on any error.
 * Schema: { entries: [{ path, basename, lastSeen }] }
 */
export function loadSeenProjects () {
  try {
    const raw = fs.readFileSync(SEEN_PROJECTS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.entries)) {
      return { entries: data.entries };
    }
  } catch {
    // fall through
  }
  return { entries: [] };
}

/**
 * Record a folder as "seen" by the notifier. Updates lastSeen in-place
 * if the path already exists, otherwise appends a new entry. Sorts by
 * lastSeen desc and trims to MAX_SEEN_ENTRIES.
 * Silent on errors — never throws.
 */
export function recordSeenProject (cwd) {
  try {
    if (!cwd) {
      return;
    }
    const normalized = normalizeForCompare(cwd);
    const data = loadSeenProjects();
    const entries = data.entries;

    const now = new Date().toISOString();
    const idx = entries.findIndex(
      (e) => normalizeForCompare(e.path) === normalized
    );
    if (idx >= 0) {
      entries[idx].lastSeen = now;
      entries[idx].path = cwd.replace(/\\/g, '/');
      entries[idx].basename = path.basename(cwd);
    } else {
      entries.push({
        path: cwd.replace(/\\/g, '/'),
        basename: path.basename(cwd),
        lastSeen: now,
      });
    }

    entries.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
    const trimmed = entries.slice(0, MAX_SEEN_ENTRIES);

    const tmp = `${SEEN_PROJECTS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: trimmed }, null, 2));
    fs.renameSync(tmp, SEEN_PROJECTS_PATH);
  } catch {
    // silent: notifier must not crash on seen-file errors
  }
}

// Plugin identity
export const HOOK_COMMAND = 'claude-notify';
export const MARKETPLACE_KEY = 'bazilio-plugins';
export const PLUGIN_KEY = 'claude-notification-plugin@bazilio-plugins';
export const MARKETPLACE_REPO = 'https://github.com/Bazilio-san/claude-plugins.git';
export const MARKETPLACE_GITHUB = 'Bazilio-san/claude-plugins';
