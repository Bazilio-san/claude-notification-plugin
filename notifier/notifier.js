#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import process from 'process';
import { execSync, spawn } from 'child_process';
import {
  CONFIG_PATH,
  STATE_PATH,
  PTY_SIGNAL_DIR,
  normalizeForCompare,
  recordSeenProject,
} from '../bin/constants.js';

// ----------------------
// CONFIG
// ----------------------

const PLATFORM = process.platform; // 'win32' | 'darwin' | 'linux'

function getDefaultSoundFile () {
  switch (PLATFORM) {
    case 'darwin': return '/System/Library/Sounds/Glass.aiff';
    case 'linux': return '/usr/share/sounds/freedesktop/stereo/complete.oga';
    default: return 'C:/Windows/Media/notify.wav';
  }
}

function debugLog (config, ...args) {
  if (config.debug) {
    console.error('[claude-notifier]', ...args);
  }
}

function resolveProjectName (cwd, config) {
  const fallback = path.basename(cwd);
  const projects = config?.listenerProjects;
  if (!projects || typeof projects !== 'object') {
    return fallback;
  }
  const normalizedCwd = normalizeForCompare(cwd);
  for (const entry of Object.values(projects)) {
    if (!entry?.path) {
      continue;
    }
    if (normalizedCwd === normalizeForCompare(entry.path) && entry.name) {
      return entry.name;
    }
  }
  return fallback;
}

function getBranch (cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 3000,
    }).trim();
  } catch {
    return '';
  }
}

function loadConfig () {
  const configPath = CONFIG_PATH;

  const config = {
    telegram: {
      enabled: true,
      token: '',
      chatId: '',
      deleteAfterHours: 24,
      includeLastCcMessageInTelegram: true,
    },
    desktopNotification: {
      enabled: true,
    },
    sound: {
      enabled: true,
      file: getDefaultSoundFile(),
    },
    voice: {
      enabled: true,
    },
    webhookUrl: '',
    notifyAfterSeconds: 15,
    notifyOnWaiting: false,
    notifyOnPermission: true,
    debug: false,
  };

  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const user = JSON.parse(raw);
      if (user.telegram) {
        config.telegram = { ...config.telegram, ...user.telegram };
      }
      if (user.desktopNotification) {
        config.desktopNotification = { ...config.desktopNotification, ...user.desktopNotification };
      }
      if (user.sound) {
        config.sound = { ...config.sound, ...user.sound };
      }
      if (user.voice) {
        config.voice = { ...config.voice, ...user.voice };
      }
      if (typeof user.notifyAfterSeconds === 'number') {
        config.notifyAfterSeconds = user.notifyAfterSeconds;
      }
      if (typeof user.notifyOnWaiting === 'boolean') {
        config.notifyOnWaiting = user.notifyOnWaiting;
      }
      if (typeof user.notifyOnPermission === 'boolean') {
        config.notifyOnPermission = user.notifyOnPermission;
      }
      if (typeof user.debug === 'boolean') {
        config.debug = user.debug;
      }
      if (typeof user.webhookUrl === 'string') {
        config.webhookUrl = user.webhookUrl;
      }
      if (user.listener?.projects) {
        config.listenerProjects = user.listener.projects;
      }
    } catch {
      // ignore malformed config
    }
  }

  if (process.env.CLAUDE_NOTIFY_TELEGRAM_TOKEN) {
    config.telegram.token = process.env.CLAUDE_NOTIFY_TELEGRAM_TOKEN;
  }
  if (process.env.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID) {
    config.telegram.chatId = process.env.CLAUDE_NOTIFY_TELEGRAM_CHAT_ID;
  }

  // Per-channel env overrides (0 = off, 1 = on)
  if (process.env.CLAUDE_NOTIFY_TELEGRAM !== undefined) {
    config.telegram.enabled = process.env.CLAUDE_NOTIFY_TELEGRAM === '1';
  }
  if (process.env.CLAUDE_NOTIFY_DESKTOP !== undefined) {
    config.desktopNotification.enabled = process.env.CLAUDE_NOTIFY_DESKTOP === '1';
  }
  if (process.env.CLAUDE_NOTIFY_SOUND !== undefined) {
    config.sound.enabled = process.env.CLAUDE_NOTIFY_SOUND === '1';
  }
  if (process.env.CLAUDE_NOTIFY_VOICE !== undefined) {
    config.voice.enabled = process.env.CLAUDE_NOTIFY_VOICE === '1';
  }
  if (process.env.CLAUDE_NOTIFY_WAITING !== undefined) {
    config.notifyOnWaiting = process.env.CLAUDE_NOTIFY_WAITING === '1';
  }
  if (process.env.CLAUDE_NOTIFY_ON_PERMISSION !== undefined) {
    config.notifyOnPermission = process.env.CLAUDE_NOTIFY_ON_PERMISSION === '1';
  }
  if (process.env.CLAUDE_NOTIFY_DEBUG !== undefined) {
    config.debug = process.env.CLAUDE_NOTIFY_DEBUG === '1';
  }
  if (process.env.CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM !== undefined) {
    config.telegram.includeLastCcMessageInTelegram = process.env.CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM === '1';
  }
  if (process.env.CLAUDE_NOTIFY_WEBHOOK_URL !== undefined) {
    config.webhookUrl = process.env.CLAUDE_NOTIFY_WEBHOOK_URL;
  }
  if (process.env.CLAUDE_NOTIFY_AFTER_SECONDS !== undefined) {
    const val = Number(process.env.CLAUDE_NOTIFY_AFTER_SECONDS);
    if (!Number.isNaN(val)) {
      config.notifyAfterSeconds = val;
    }
  }

  return config;
}

// ----------------------
// PROJECT-LEVEL DISABLE
// ----------------------

function isNotifierDisabled () {
  if (process.env.CLAUDE_NOTIFY_DISABLE === '1'
    || process.env.CLAUDE_NOTIFY_DISABLE === 'true') {
    return true;
  }
  // Skip notifications for listener-spawned tasks unless explicitly enabled
  if (process.env.CLAUDE_NOTIFY_FROM_LISTENER === '1'
    && process.env.CLAUDE_NOTIFY_AFTER_LISTENER !== '1') {
    return 'listener-only';
  }
  return false;
}

function writeSignalFile (name, data) {
  try {
    fs.mkdirSync(PTY_SIGNAL_DIR, { recursive: true });
    fs.writeFileSync(path.join(PTY_SIGNAL_DIR, name), JSON.stringify(data));
  } catch {
    // silent fail
  }
}

function writePtySignalFile (event) {
  const sessionId = event.session_id || 'unknown';
  writeSignalFile(`${sessionId}.json`, {
    sessionId,
    cwd: event.cwd || process.cwd(),
    lastAssistantMessage: event.last_assistant_message || '',
    cost: event.total_cost_usd || 0,
    numTurns: event.num_turns || 0,
    durationMs: event.duration_ms || 0,
    timestamp: Date.now(),
  });
}

function writeErrorSignalFile (event) {
  const sessionId = event.session_id || 'unknown';
  writeSignalFile(`err_${sessionId}.json`, {
    type: 'error',
    cwd: event.cwd || process.cwd(),
    error: event.error || 'unknown',
    errorDetails: event.error_details || '',
    lastAssistantMessage: event.last_assistant_message || '',
    timestamp: Date.now(),
  });
}

function writeReadySignalFile (event) {
  const sessionId = event.session_id || 'unknown';
  writeSignalFile(`rdy_${sessionId}.json`, {
    type: 'ready',
    cwd: event.cwd || process.cwd(),
    model: event.model || '',
    source: event.source || '',
    timestamp: Date.now(),
  });
}

function writeActivitySignalFile (event) {
  const sessionId = event.session_id || 'unknown';
  writeSignalFile(`act_${sessionId}.json`, {
    type: 'activity',
    cwd: event.cwd || process.cwd(),
    toolName: event.tool_name || '',
    toolInput: event.tool_input || {},
    timestamp: Date.now(),
  });
}

function writeCompactSignalFile (event) {
  const sessionId = event.session_id || 'unknown';
  writeSignalFile(`cmp_${sessionId}.json`, {
    type: 'compact',
    cwd: event.cwd || process.cwd(),
    summary: event.compact_summary || '',
    trigger: event.trigger || '',
    timestamp: Date.now(),
  });
}

// ----------------------
// STATE FILE
// ----------------------

function loadState () {
  if (fs.existsSync(STATE_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      // Migrate flat state (pre-session format) to new format
      if (!raw.sessions && raw.start !== undefined) {
        return { sessions: {}, sentMessages: raw.sentMessages || [] };
      }
      if (!raw.sessions) {
        raw.sessions = {};
      }
      if (!raw.sentMessages) {
        raw.sentMessages = [];
      }
      return raw;
    } catch {
      return { sessions: {}, sentMessages: [] };
    }
  }
  return { sessions: {}, sentMessages: [] };
}

function saveState (state) {
  const dir = path.dirname(STATE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
}

function cleanStaleSessions (state) {
  const maxAge = 24 * 3600_000;
  const now = Date.now();
  for (const sid of Object.keys(state.sessions)) {
    if (now - state.sessions[sid].start > maxAge) {
      delete state.sessions[sid];
    }
  }
}

// ----------------------
// TELEGRAM
// ----------------------

function escapeHtml (text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function markdownToTelegramHtml (md) {
  const codeBlocks = [];
  const inlineCodes = [];

  // Extract fenced code blocks
  let result = md.replace(/```[\s\S]*?```/g, (m) => {
    const idx = codeBlocks.length;
    const inner = m.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    codeBlocks.push(`<pre>${escapeHtml(inner)}</pre>`);
    return `\x00CB${idx}\x00`;
  });

  // Extract inline code
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Headers → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic: *text* (but not inside words with asterisks)
  result = result.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks and inline codes
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[i]);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[i]);

  return result;
}

async function sendTelegram (config, state) {
  if (!config.telegram.enabled || !config.telegram.token || !config.telegram.chatId) {
    return;
  }

  const baseUrl = `https://api.telegram.org/bot${config.telegram.token}`;

  // Send new message and store its id
  try {
    const body = {
      chat_id: config.telegram.chatId,
      text: state._telegramText,
    };
    body.parse_mode = 'HTML';
    const res = await fetch(`${baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[telegram] HTML send failed:', JSON.stringify(data));
    }
    if (data.ok && data.result?.message_id) {
      if (!state.sentMessages) {
        state.sentMessages = [];
      }
      state.sentMessages.push({
        id: data.result.message_id,
        ts: Date.now(),
      });
    } else if (!data.ok && body.parse_mode) {
      // Retry without formatting if HTML parsing failed
      const retryRes = await fetch(`${baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: body.chat_id,
          text: body.text,
        }),
      });
      const retryData = await retryRes.json();
      if (retryData.ok && retryData.result?.message_id) {
        if (!state.sentMessages) {
          state.sentMessages = [];
        }
        state.sentMessages.push({
          id: retryData.result.message_id,
          ts: Date.now(),
        });
      }
    }
  } catch {
    // silent fail
  }

  // Delete old messages
  const maxAge = (config.telegram.deleteAfterHours || 24) * 3600_000;
  if (state.sentMessages?.length) {
    const now = Date.now();
    const keep = [];
    for (const msg of state.sentMessages) {
      if (now - msg.ts > maxAge) {
        try {
          await fetch(`${baseUrl}/deleteMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: config.telegram.chatId,
              message_id: msg.id,
            }),
          });
        } catch {
          // silent fail
        }
      } else {
        keep.push(msg);
      }
    }
    state.sentMessages = keep;
  }
}

// ----------------------
// WEBHOOK
// ----------------------

async function sendWebhook (config, payload) {
  if (!config.webhookUrl) {
    return;
  }
  try {
    await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    debugLog(config, 'sendWebhook failed:', err.message);
  }
}

// ----------------------
// DESKTOP NOTIFICATION
// ----------------------

function sendNativeFallback (config, title, message) {
  try {
    switch (PLATFORM) {
      case 'darwin': {
        const escapedMsg = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const escapedTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        spawn('osascript', ['-e', `display notification "${escapedMsg}" with title "${escapedTitle}"`], {
          stdio: 'ignore',
        });
        break;
      }
      case 'linux':
        spawn('notify-send', [title, message], {
          stdio: 'ignore',
        });
        break;
    }
  } catch (err) {
    debugLog(config, 'native notification fallback failed:', err.message);
  }
}

async function sendDesktopNotification (config, title, message) {
  if (!config.desktopNotification.enabled) {
    return;
  }
  try {
    const { default: notifier } = await import('node-notifier');
    let iconPath = new URL('../claude_img/claude.png', import.meta.url).pathname
      .replace(/^\/([a-zA-Z]:)/, '$1');
    if (PLATFORM === 'win32') {
      iconPath = path.resolve(iconPath);
    }
    notifier.notify({
      title,
      message,
      icon: iconPath,
      sound: false,
      wait: false,
      appID: 'Claude Notify',
    });
  } catch (err) {
    debugLog(config, 'node-notifier failed, trying native fallback:', err.message);
    sendNativeFallback(config, title, message);
  }
}

// ----------------------
// SOUND & VOICE
// ----------------------

function playSound (config) {
  if (!config.sound.enabled) {
    return;
  }
  const file = config.sound.file;
  try {
    switch (PLATFORM) {
      case 'win32': {
        const psCommand = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
        spawn('powershell', ['-Command', psCommand], {
          stdio: 'ignore',
          windowsHide: true,
        });
        break;
      }
      case 'darwin':
        spawn('afplay', [file], { stdio: 'ignore' });
        break;
      case 'linux': {
        const child = spawn('paplay', [file], { stdio: 'ignore' });
        child.on('error', () => {
          spawn('aplay', [file], { stdio: 'ignore' });
        });
        break;
      }
    }
  } catch (err) {
    debugLog(config, 'playSound failed:', err.message);
  }
}

function pluralize (n, forms) {
  // forms: [one, few, many] e.g. ['секунда', 'секунды', 'секунд']
  if (forms.length === 1) {
    return forms[0];
  }
  if (forms.length === 2) {
    return n === 1 ? forms[0] : forms[1];
  }
  // Slavic pluralization (ru, uk, pl, etc.)
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
    return forms[1];
  }
  return forms[2];
}

// ----------------------
// NUMBER TO WORDS
// ----------------------

const numWordsEn = {
  ones: ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen'],
  tens: ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'],
};

function numberToWordsEn (n) {
  if (n === 0) {
    return 'zero';
  }
  const parts = [];
  if (n >= 1000) {
    parts.push(numWordsEn.ones[Math.floor(n / 1000)] + ' thousand');
    n %= 1000;
  }
  if (n >= 100) {
    parts.push(numWordsEn.ones[Math.floor(n / 100)] + ' hundred');
    n %= 100;
  }
  if (n >= 20) {
    const t = numWordsEn.tens[Math.floor(n / 10)];
    const o = numWordsEn.ones[n % 10];
    parts.push(o ? `${t}-${o}` : t);
  } else if (n > 0) {
    parts.push(numWordsEn.ones[n]);
  }
  return parts.join(' ');
}

// Russian: feminine accusative for "секунду" (одну, две)
const numWordsRu = {
  ones: ['', 'одну', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять',
    'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать',
    'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
  tens: ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят',
    'семьдесят', 'восемьдесят', 'девяносто'],
  hundreds: ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот',
    'семьсот', 'восемьсот', 'девятьсот'],
  thousands: ['тысяча', 'тысячи', 'тысяч'],
  thousandOnes: ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'],
};

function numberToWordsRu (n) {
  if (n === 0) {
    return 'ноль';
  }
  const parts = [];
  if (n >= 1000) {
    const th = Math.floor(n / 1000);
    if (th >= 100) {
      parts.push(numWordsRu.hundreds[Math.floor(th / 100)]);
    }
    let thRem = th % 100;
    if (thRem >= 20) {
      parts.push(numWordsRu.tens[Math.floor(thRem / 10)]);
      thRem %= 10;
    }
    if (thRem > 0 && thRem < 20) {
      parts.push(thRem < 10 ? numWordsRu.thousandOnes[thRem] : numWordsRu.ones[thRem]);
    }
    parts.push(pluralize(th, numWordsRu.thousands));
    n %= 1000;
  }
  if (n >= 100) {
    parts.push(numWordsRu.hundreds[Math.floor(n / 100)]);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(numWordsRu.tens[Math.floor(n / 10)]);
    n %= 10;
  }
  if (n > 0) {
    parts.push(numWordsRu.ones[n]);
  }
  return parts.join(' ');
}

function numberToWords (n, lang) {
  if (lang === 'ru') {
    return numberToWordsRu(n);
  }
  if (lang === 'en') {
    return numberToWordsEn(n);
  }
  return String(n);
}

const voicePhrases = {
  en: (d, p) => `Claude finished working on ${p} in ${numberToWords(d, 'en')} ${pluralize(d, ['second', 'seconds'])}`,
  ru: (d, p) => `Клод завершил работу над проектом ${p} за ${numberToWords(d, 'ru')} ${pluralize(d, ['секунду', 'секунды', 'секунд'])}`,
  de: (d, p) => `Claude hat die Arbeit an ${p} in ${d} ${pluralize(d, ['Sekunde', 'Sekunden'])} abgeschlossen`,
  fr: (d, p) => `Claude a termine ${p} en ${d} ${pluralize(d, ['seconde', 'secondes'])}`,
  es: (d, p) => `Claude termino ${p} en ${d} ${pluralize(d, ['segundo', 'segundos'])}`,
  pt: (d, p) => `Claude terminou ${p} em ${d} ${pluralize(d, ['segundo', 'segundos'])}`,
  ja: (d, p) => `Claudeは${p}の作業を${d}秒で完了しました`,
  ko: (d, p) => `Claude가 ${p} 작업을 ${d}초 만에 완료했습니다`,
};

function getVoicePhrase (duration, project) {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const lang = locale.split('-')[0].toLowerCase();
  const fn = voicePhrases[lang] || voicePhrases.en;
  return fn(duration, project || 'unknown');
}

function speakText (config, text) {
  if (!config.voice.enabled) {
    return;
  }
  try {
    switch (PLATFORM) {
      case 'win32': {
        const psCommand = [
          'Add-Type -AssemblyName System.Speech;',
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
          `$s.Speak("${text.replace(/"/g, '`"')}");`,
        ].join('');
        spawn('powershell', ['-Command', psCommand], {
          stdio: 'ignore',
          windowsHide: true,
        });
        break;
      }
      case 'darwin':
        spawn('say', [text], { stdio: 'ignore' });
        break;
      case 'linux': {
        const child = spawn('spd-say', [text], { stdio: 'ignore' });
        child.on('error', () => {
          spawn('espeak', [text], { stdio: 'ignore' });
        });
        break;
      }
    }
  } catch (err) {
    debugLog(config, 'speakText failed:', err.message);
  }
}

function speakResult (config, duration, project) {
  speakText(config, getVoicePhrase(duration, project));
}

const permissionVoicePhrases = {
  en: (p, tool) => `Claude needs your permission on ${p} for ${tool}`,
  ru: (p, tool) => `Клод ожидает разрешение в проекте ${p} на ${tool}`,
};

function getPermissionVoicePhrase (project, toolName) {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const lang = locale.split('-')[0].toLowerCase();
  const fn = permissionVoicePhrases[lang] || permissionVoicePhrases.en;
  return fn(project || 'unknown', toolName || 'unknown');
}

// ----------------------
// READ HOOK INPUT
// ----------------------

let input = '';

process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', async () => {
  const config = loadConfig();

  let event = {};
  try {
    event = JSON.parse(input);
  } catch {
    // ignore
  }

  const eventType = event.hook_event_name || 'unknown';
  const cwd = event.cwd || process.cwd();
  const project = resolveProjectName(cwd, config);
  const sessionId = event.session_id || 'default';

  // Record this cwd in the seen-projects file for /add-project /basename
  // resolution and the /seen listener command. Silent on errors.
  recordSeenProject(cwd);

  const disabled = isNotifierDisabled();
  if (disabled === true) {
    process.exit(0);
  }

  // For listener-only mode: handle events via signal files, then exit
  if (disabled === 'listener-only') {
    switch (eventType) {
      case 'PermissionRequest':
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        }));
        break;
      case 'Stop':
        writePtySignalFile(event);
        break;
      case 'StopFailure':
        writeErrorSignalFile(event);
        break;
      case 'SessionStart':
        writeReadySignalFile(event);
        break;
      case 'PostToolUse':
        writeActivitySignalFile(event);
        break;
      case 'PostCompact':
        writeCompactSignalFile(event);
        break;
    }
    process.exit(0);
  }

  const state = loadState();
  cleanStaleSessions(state);

  // ----------------------
  // START TIMER
  // ----------------------

  if (eventType === 'UserPromptSubmit') {
    state.sessions[sessionId] = { start: Date.now() };
    saveState(state);
    await sendWebhook(config, {
      title: 'User prompt submitted',
      project,
      trigger: eventType,
      prompt: event.prompt || '',
      hookEvent: event,
    });
    process.exit(0);
  }

  // ----------------------
  // STOP / NOTIFICATION EVENT
  // ----------------------

  if (eventType !== 'Stop' && eventType !== 'Notification' && eventType !== 'StopFailure' && eventType !== 'PermissionRequest') {
    process.exit(0);
  }

  if (eventType === 'Notification' && !config.notifyOnWaiting) {
    process.exit(0);
  }

  if (eventType === 'PermissionRequest' && !config.notifyOnPermission) {
    process.exit(0);
  }

  let duration = 0;
  const session = state.sessions[sessionId];
  if (session?.start) {
    duration = Math.round((Date.now() - session.start) / 1000);
  }

  if (duration < config.notifyAfterSeconds) {
    process.exit(0);
  }

  const permToolName = event.tool_name || 'unknown';
  const permDetail = event.tool_input?.file_path || event.tool_input?.command?.slice(0, 80) || '';

  const statusEmoji = eventType === 'PermissionRequest' ? '🔐' : eventType === 'Notification' ? '⏸' : eventType === 'StopFailure' ? '❌' : '✅';

  let desktopStatus;
  if (eventType === 'PermissionRequest') {
    desktopStatus = `Permission: ${permToolName}${permDetail ? ` — ${path.basename(permDetail)}` : ''}`;
  } else if (eventType === 'Notification') {
    desktopStatus = 'Waiting';
  } else if (eventType === 'StopFailure') {
    desktopStatus = `Error: ${event.error || 'unknown'}`;
  } else {
    desktopStatus = 'Finished';
  }

  const branch = getBranch(cwd);
  let label = `/${project}`;
  let labelHtml = `/${escapeHtml(project)}`;
  if (branch) {
    label += `/${branch}`;
    labelHtml += `/${escapeHtml(branch)}`;
  }
  labelHtml = `<code>${labelHtml}</code>`;
  const triggerLine = config.debug ? `\nTrigger: ${eventType}` : '';

  const desktopTitle = label;
  const desktopMessage = desktopStatus;

  let telegramMessage;
  if (eventType === 'PermissionRequest') {
    telegramMessage = `${statusEmoji}  ${labelHtml}\nPermission: <b>${escapeHtml(permToolName)}</b>`;
    if (permDetail) {
      telegramMessage += `\n<code>${escapeHtml(permDetail)}</code>`;
    }
    telegramMessage += `\n(duration: ${duration}s)${triggerLine}`;
  } else {
    telegramMessage = `${statusEmoji}  ${labelHtml}\n(duration: ${duration}s)${triggerLine}`;
  }

  if (config.telegram.includeLastCcMessageInTelegram && event.last_assistant_message) {
    const maxLen = 3500;
    let lastMsg = event.last_assistant_message;
    if (lastMsg.length > maxLen) {
      lastMsg = lastMsg.slice(0, maxLen) + '…';
    }
    telegramMessage += `\n\n${markdownToTelegramHtml(lastMsg)}`;
  }

  if (config.debug) {
    const debugBlockHtml = '\n\n<b>Debug:</b>\n'
      + (config.voice.enabled ? `\nVoice: ${escapeHtml(getVoicePhrase(duration, project))}` : '')
      + `\n\nHook input:\n<pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre>`;
    telegramMessage += debugBlockHtml;
  }

  const webhookPayload = {
    title: `${desktopStatus}: ${label}`,
    project,
    branch: branch || undefined,
    duration,
    trigger: eventType,
    hookEvent: event,
  };
  if (eventType === 'PermissionRequest') {
    webhookPayload.toolName = permToolName;
    webhookPayload.toolInput = event.tool_input || {};
  }
  if (config.voice.enabled) {
    webhookPayload.voicePhrase = eventType === 'PermissionRequest'
      ? getPermissionVoicePhrase(project, permToolName)
      : getVoicePhrase(duration, project);
  }
  await sendWebhook(config, webhookPayload);

  state._telegramText = telegramMessage;
  await sendTelegram(config, state);
  delete state._telegramText;
  if (eventType === 'Stop') {
    delete state.sessions[sessionId];
  }
  saveState(state);

  await sendDesktopNotification(config, desktopTitle, desktopMessage);
  playSound(config);
  if (eventType === 'PermissionRequest') {
    speakText(config, getPermissionVoicePhrase(project, permToolName));
  } else {
    speakResult(config, duration, project);
  }
});
