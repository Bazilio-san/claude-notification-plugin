import os from 'os';
import path from 'path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

// File names
export const CONFIG_FILENAME = 'claude-notify.config.json';
export const STATE_FILENAME = '.notifier_state.json';
export const PID_FILENAME = '.listener.pid';
export const RESOLVER_FILENAME = 'claude-notify-resolve.js';
export const LISTENER_LOG_FILENAME = '.cc-n-listener.log';
export const INSTALL_LOG_FILENAME = 'claude-notify-install.log';

// PTY signal directory
export const PTY_SIGNAL_DIR = path.join(CLAUDE_DIR, 'pty-signals');

// Full paths
export const CONFIG_PATH = path.join(CLAUDE_DIR, CONFIG_FILENAME);
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

// Plugin identity
export const HOOK_COMMAND = 'claude-notify';
export const MARKETPLACE_KEY = 'bazilio-plugins';
export const PLUGIN_KEY = 'claude-notification-plugin@bazilio-plugins';
export const MARKETPLACE_REPO = 'https://github.com/Bazilio-san/claude-plugins.git';
export const MARKETPLACE_GITHUB = 'Bazilio-san/claude-plugins';
