#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const os = await import('os');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env from .claude/settings.local.json
const settingsPath = path.join(__dirname, '.claude', 'settings.local.json');
if (fs.existsSync(settingsPath)) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (settings.env) {
      for (const [key, value] of Object.entries(settings.env)) {
        process.env[key] = String(value);
      }
    }
    console.log(`Loaded env from ${settingsPath}
   ${JSON.stringify(settings.env, null, 2).replaceAll('\n', '\n   ')}`);
  } catch {
    console.log('Failed to parse', settingsPath);
  }
} else {
  console.log('No settings.local.json found, using defaults');
}

// Emulate a Stop event after 20s of work
const sessionId = 'test-session';
const event = {
  hook_event_name: 'Stop',
  session_id: sessionId,
  cwd: __dirname,
  last_assistant_message: '## Summary\n\nI\'ve updated the **notification system** with:\n\n- `markdownToTelegramHtml()` converter\n- *Italic* and ~~strikethrough~~ support\n\n```js\nconsole.log("hello");\n```\n\nDone!',
};

// Validate Telegram credentials if Telegram is enabled
const telegramEnabled = process.env.CLAUDE_NOTIFY_TELEGRAM !== '0';
if (telegramEnabled) {
  const configPath = path.join(os.default.homedir(), '.claude', 'notifier.config.json');
  let token = process.env.CLAUDE_NOTIFY_TELEGRAM_TOKEN;
  let chatId = process.env.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      token = token || cfg.telegram?.token;
      chatId = chatId || cfg.telegram?.chatId;
    } catch {
      // no config file
    }
  }
  const missing = [];
  if (!token) {
    missing.push('CLAUDE_NOTIFY_TELEGRAM_TOKEN');
  }
  if (!chatId) {
    missing.push('CLAUDE_NOTIFY_TELEGRAM_CHAT_ID');
  }
  if (missing.length) {
    console.error(`\x1b[31mError: ${missing.join(' and ')} not set.\x1b[0m`);
    console.error('\x1b[31mSet them in env, .claude/settings.local.json, or run: claude-notify install\x1b[0m');
    process.exit(1);
  }
}

// First, write a fake start timestamp (20s ago) to state file
const statePath = path.join(os.default.homedir(), '.claude', '.notifier_state.json');
const fakeStart = Date.now() - 20_000;
fs.writeFileSync(statePath, JSON.stringify({
  sessions: { [sessionId]: { start: fakeStart } },
  sentMessages: [],
}));
console.log(`\nSimulating task duration: 20s (start set to ${new Date(fakeStart).toLocaleTimeString()})
Sending Stop event to notifier...\n`);

// Spawn notifier and pipe the event JSON
const notifier = spawn('node', [path.join(__dirname, 'notifier', 'notifier.js')], {
  env: { ...process.env },
  stdio: ['pipe', 'inherit', 'inherit'],
});

notifier.stdin.write(JSON.stringify(event));
notifier.stdin.end();

notifier.on('close', (code) => {
  console.log(`\nNotifier exited with code ${code}`);
  process.exit(0);
});
