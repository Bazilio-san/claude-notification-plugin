#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import process from 'process';
import { execSync, spawn } from 'child_process';
import { CONFIG_PATH, STATE_PATH } from '../bin/constants.js';

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
    sendUserPromptToWebhook: false,
    notifyAfterSeconds: 15,
    notifyOnWaiting: false,
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
      if (typeof user.debug === 'boolean') {
        config.debug = user.debug;
      }
      if (typeof user.webhookUrl === 'string') {
        config.webhookUrl = user.webhookUrl;
      }
      if (typeof user.sendUserPromptToWebhook === 'boolean') {
        config.sendUserPromptToWebhook = user.sendUserPromptToWebhook;
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
  if (process.env.CLAUDE_NOTIFY_DEBUG !== undefined) {
    config.debug = process.env.CLAUDE_NOTIFY_DEBUG === '1';
  }
  if (process.env.CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM !== undefined) {
    config.telegram.includeLastCcMessageInTelegram = process.env.CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM === '1';
  }
  if (process.env.CLAUDE_NOTIFY_WEBHOOK_URL) {
    config.webhookUrl = process.env.CLAUDE_NOTIFY_WEBHOOK_URL;
  }
  if (process.env.CLAUDE_NOTIFY_SEND_USER_PROMPT_TO_WEBHOOK !== undefined) {
    config.sendUserPromptToWebhook = process.env.CLAUDE_NOTIFY_SEND_USER_PROMPT_TO_WEBHOOK === '1';
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
  return process.env.CLAUDE_NOTIFY_FROM_LISTENER === '1'
    && process.env.CLAUDE_NOTIFY_AFTER_LISTENER !== '1';

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

function sendNativeFallback (config, message) {
  try {
    switch (PLATFORM) {
      case 'darwin': {
        const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        spawn('osascript', ['-e', `display notification "${escaped}" with title "Claude Code"`], {
          stdio: 'ignore',
        });
        break;
      }
      case 'linux':
        spawn('notify-send', ['Claude Code', message], {
          stdio: 'ignore',
        });
        break;
    }
  } catch (err) {
    debugLog(config, 'native notification fallback failed:', err.message);
  }
}

async function sendDesktopNotification (config, message) {
  if (!config.desktopNotification.enabled) {
    return;
  }
  try {
    const { default: notifier } = await import('node-notifier');
    const iconPath = new URL('../claude_img/claude.png', import.meta.url).pathname
      .replace(/^\/([a-zA-Z]:)/, '$1');
    notifier.notify({
      title: 'Claude Code',
      message,
      icon: iconPath,
      sound: false,
      wait: false,
    });
  } catch (err) {
    debugLog(config, 'node-notifier failed, trying native fallback:', err.message);
    sendNativeFallback(config, message);
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
  en: (d) => `Claude finished coding in ${numberToWords(d, 'en')} ${pluralize(d, ['second', 'seconds'])}`,
  ru: (d) => `Клод завершил работу за ${numberToWords(d, 'ru')} ${pluralize(d, ['секунду', 'секунды', 'секунд'])}`,
  de: (d) => `Claude hat die Arbeit in ${d} ${pluralize(d, ['Sekunde', 'Sekunden'])} abgeschlossen`,
  fr: (d) => `Claude a termine en ${d} ${pluralize(d, ['seconde', 'secondes'])}`,
  es: (d) => `Claude termino en ${d} ${pluralize(d, ['segundo', 'segundos'])}`,
  pt: (d) => `Claude terminou em ${d} ${pluralize(d, ['segundo', 'segundos'])}`,
  ja: (d) => `Claudeは${d}秒でコーディングを完了しました`,
  ko: (d) => `Claude가 ${d}초 만에 코딩을 완료했습니다`,
};

function getVoicePhrase (duration) {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en';
  const lang = locale.split('-')[0].toLowerCase();
  const fn = voicePhrases[lang] || voicePhrases.en;
  return fn(duration);
}

function speakResult (config, duration) {
  if (!config.voice.enabled) {
    return;
  }
  const text = getVoicePhrase(duration);
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
    debugLog(config, 'speakResult failed:', err.message);
  }
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
  const project = path.basename(cwd);
  const sessionId = event.session_id || 'default';

  if (isNotifierDisabled()) {
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
    if (config.sendUserPromptToWebhook) {
      await sendWebhook(config, {
        title: 'User prompt submitted',
        project,
        trigger: eventType,
        prompt: event.prompt || '',
        hookEvent: event,
      });
    }
    process.exit(0);
  }

  // ----------------------
  // STOP / NOTIFICATION EVENT
  // ----------------------

  if (eventType !== 'Stop' && eventType !== 'Notification') {
    process.exit(0);
  }

  if (eventType === 'Notification' && !config.notifyOnWaiting) {
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

  const statusEmoji = eventType === 'Notification' ? '⏸' : '✅';
  const desktopStatus = eventType === 'Notification' ? 'Waiting' : 'Finished';

  const branch = getBranch(cwd);
  const label = branch ? `@${project}/${branch}` : `@${project}`;
  const labelHtml = branch
    ? `@<b>${escapeHtml(project)}</b>/<b>${escapeHtml(branch)}</b>`
    : `@<b>${escapeHtml(project)}</b>`;

  const triggerLine = config.debug ? `\nTrigger: ${eventType}` : '';

  const desktopMessage = `${desktopStatus}: ${label}`;

  let telegramMessage =
    `${statusEmoji} ${labelHtml} (duration: ${duration}s)${triggerLine}`;

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
      + (config.voice.enabled ? `\nVoice: ${escapeHtml(getVoicePhrase(duration))}` : '')
      + `\n\nHook input:\n<pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre>`;
    telegramMessage += debugBlockHtml;
  }

  await sendWebhook(config, {
    title: `${desktopStatus}: ${label}`,
    project,
    branch: branch || undefined,
    duration,
    trigger: eventType,
    voicePhrase: config.voice.enabled ? getVoicePhrase(duration) : null,
    hookEvent: event,
  });

  state._telegramText = telegramMessage;
  await sendTelegram(config, state);
  delete state._telegramText;
  if (eventType === 'Stop') {
    delete state.sessions[sessionId];
  }
  saveState(state);

  await sendDesktopNotification(config, desktopMessage);
  playSound(config);
  speakResult(config, duration);
});
