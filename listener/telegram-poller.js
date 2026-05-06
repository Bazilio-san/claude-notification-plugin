#!/usr/bin/env node

const POLL_TIMEOUT = 30; // seconds
const MAX_MESSAGE_LENGTH = 4096;
// Telegram allows exactly one getUpdates consumer per token. If we keep seeing
// 409 it means another instance is polling — exit so the user notices instead
// of looping silently.
const MAX_CONSECUTIVE_409 = 8;

export class TelegramPoller {
  constructor (token, chatId, logger) {
    this.token = token;
    this.chatId = String(chatId);
    this.logger = logger;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
    this._errorBackoff = 0; // current backoff in ms (0 = no backoff)
    this._consecutiveErrors = 0;
    this._consecutive409 = 0;
  }

  async flush () {
    try {
      const url = `${this.baseUrl}/getUpdates?offset=-1&timeout=0&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      if (data.ok && data.result?.length) {
        this.offset = data.result[data.result.length - 1].update_id + 1;
      }
    } catch {
      // ignore — first getUpdates will still work with offset=0
    }
  }

  async getUpdates () {
    // Apply backoff delay if we've had consecutive errors
    if (this._errorBackoff > 0) {
      await new Promise((resolve) => setTimeout(resolve, this._errorBackoff));
    }

    try {
      const url = `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`;
      const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000) });
      const data = await res.json();
      if (!data.ok) {
        if (data.error_code === 409) {
          this._consecutive409++;
          if (this._consecutive409 >= MAX_CONSECUTIVE_409) {
            this.logger.error(
              `409 Conflict persists after ${this._consecutive409} attempts — `
              + 'another listener is holding the bot token. Exiting.',
            );
            console.error(
              `409 Conflict persists after ${this._consecutive409} attempts — `
              + 'another listener (or stray getUpdates consumer) is holding the bot token. Exiting.',
            );
            process.exit(2);
          }
          this.logger.warn(`getUpdates 409 Conflict (attempt ${this._consecutive409}/${MAX_CONSECUTIVE_409})`);
        } else {
          this.logger.error(`getUpdates failed: ${JSON.stringify(data)}`);
        }
        this._applyBackoff();
        return [];
      }
      // Success — reset backoff
      if (this._consecutiveErrors > 0) {
        this.logger.info('getUpdates recovered after errors');
      }
      this._consecutiveErrors = 0;
      this._consecutive409 = 0;
      this._errorBackoff = 0;

      const messages = [];
      for (const update of data.result || []) {
        this.offset = update.update_id + 1;

        // Handle callback_query (inline button press)
        const cb = update.callback_query;
        if (cb) {
          if (String(cb.message?.chat?.id) !== this.chatId) {
            continue;
          }
          messages.push({
            messageId: cb.message.message_id,
            text: cb.data,
            chatId: cb.message.chat.id,
            date: cb.message.date,
            callbackQueryId: cb.id,
          });
          continue;
        }

        const msg = update.message;
        if (!msg || !msg.text) {
          continue;
        }
        if (String(msg.chat.id) !== this.chatId) {
          this.logger.warn(`Ignored message from chat ${msg.chat.id} (expected ${this.chatId})`);
          continue;
        }
        messages.push({
          messageId: msg.message_id,
          text: msg.text,
          chatId: msg.chat.id,
          date: msg.date,
        });
      }
      return messages;
    } catch (err) {
      if (err.name !== 'TimeoutError' && err.name !== 'AbortError') {
        this._applyBackoff();
        this.logger.error(`getUpdates error: ${err.message} (retry in ${Math.round(this._errorBackoff / 1000)}s)`);
      }
      return [];
    }
  }

  _applyBackoff () {
    this._consecutiveErrors++;
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (max)
    this._errorBackoff = Math.min(1000 * Math.pow(2, this._consecutiveErrors - 1), 30000);
  }

  async sendMessage (text, replyToMessageId, replyMarkup) {
    const chunks = splitMessage(text);
    let firstMessageId = null;
    for (let i = 0; i < chunks.length; i++) {
      // Inline keyboard attaches only to the final chunk
      const markup = (replyMarkup && i === chunks.length - 1) ? replyMarkup : null;
      const id = await this._sendChunk(chunks[i], replyToMessageId, markup);
      if (id && !firstMessageId) {
        firstMessageId = id;
      }
    }
    return firstMessageId;
  }

  // Send one chunk. Tries HTML first; on failure (e.g. malformed entities), retries
  // as plain text. Returns Telegram messageId on success, null on hard failure.
  async _sendChunk (text, replyToMessageId, replyMarkup) {
    const base = { chat_id: this.chatId, text };
    if (replyToMessageId) {
      base.reply_to_message_id = replyToMessageId;
    }
    if (replyMarkup) {
      base.reply_markup = replyMarkup;
    }
    try {
      let res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, parse_mode: 'HTML' }),
      });
      let data = await res.json();
      if (data.ok) {
        return data.result.message_id;
      }
      const htmlErr = data.description || `error_code ${data.error_code}`;
      // Retry without HTML parse mode (covers entity-parsing errors)
      res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(base),
      });
      data = await res.json();
      if (data.ok) {
        this.logger.warn(`sendMessage: HTML failed (${htmlErr}), plain succeeded`);
        return data.result.message_id;
      }
      this.logger.error(`sendMessage failed: HTML=${htmlErr}, plain=${data.description || data.error_code}`);
      return null;
    } catch (err) {
      this.logger.error(`sendMessage error: ${err.message}`);
      return null;
    }
  }

  async answerCallbackQuery (callbackQueryId, text) {
    try {
      const body = { callback_query_id: callbackQueryId };
      if (text) {
        body.text = text;
      }
      await fetch(`${this.baseUrl}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(`answerCallbackQuery error: ${err.message}`);
    }
  }

  async deleteMessage (messageId) {
    if (!messageId) {
      return;
    }
    try {
      await fetch(`${this.baseUrl}/deleteMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: messageId,
        }),
      });
    } catch (err) {
      this.logger.error(`deleteMessage error: ${err.message}`);
    }
  }

  async editMessage (messageId, text) {
    if (!messageId) {
      return false;
    }
    try {
      const res = await fetch(`${this.baseUrl}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.chatId,
          message_id: messageId,
          text,
          parse_mode: 'HTML',
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        // Retry without HTML parse mode if formatting fails
        const res2 = await fetch(`${this.baseUrl}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            message_id: messageId,
            text,
          }),
        });
        const data2 = await res2.json();
        return data2.ok;
      }
      return true;
    } catch (err) {
      this.logger.error(`editMessage error: ${err.message}`);
      return false;
    }
  }

  async setMyCommands (commands) {
    try {
      await fetch(`${this.baseUrl}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      });
    } catch (err) {
      this.logger.error(`setMyCommands error: ${err.message}`);
    }
  }

  async sendDocument (buffer, filename, caption) {
    try {
      const formData = new FormData();
      formData.append('chat_id', this.chatId);
      formData.append('document', new Blob([buffer]), filename);
      if (caption) {
        formData.append('caption', caption.slice(0, 1024));
      }
      await fetch(`${this.baseUrl}/sendDocument`, {
        method: 'POST',
        body: formData,
      });
    } catch (err) {
      this.logger.error(`sendDocument error: ${err.message}`);
    }
  }
}

function escapeHtml (text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function splitMessage (text) {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    return [text];
  }

  // For very long messages, send summary + file
  if (text.length > 20000) {
    const head = text.slice(0, 2000);
    const tail = text.slice(-2000);
    return [`${head}\n\n<i>... (truncated ${text.length} chars) ...</i>\n\n${tail}`];
  }

  // Split into chunks with tiered preference: paragraph → line → space → hard.
  // Each tier is accepted only if it falls past the midpoint, otherwise
  // we'd produce a tiny chunk followed by a huge one.
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    const para = remaining.lastIndexOf('\n\n', MAX_MESSAGE_LENGTH);
    const line = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    const space = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
    const half = MAX_MESSAGE_LENGTH / 2;
    let splitAt;
    if (para > half) {
      splitAt = para;
    } else if (line > half) {
      splitAt = line;
    } else if (space > 0) {
      splitAt = space;
    } else {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }
  return chunks;
}

// Strip ANSI escape codes and terminal control sequences from PTY output
function stripAnsi (text) {
  let result = text
    // Cursor-right (\x1b[<N>C) → replace with N spaces (preserves word spacing)
    .replace(/\x1b\[(\d+)C/g, (_, n) => ' '.repeat(parseInt(n, 10)))
    // Cursor-position (\x1b[<row>;<col>H) → replace with newline (absolute move = new line)
    .replace(/\x1b\[\d+;\d+H/g, '\n')
    // CSI sequences: \x1b[ followed by optional ?/>/! prefix, params, and terminator
    .replace(/\x1b\[[?>=!]?[0-9;]*[a-zA-Z~]/g, '')
    // OSC sequences: \x1b] ... (terminated by BEL or ST)
    .replace(/\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Other two-char escape sequences (\x1b followed by any single char)
    .replace(/\x1b[^[\]]/g, '')
    // Remaining control chars except newline, tab, and CR
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // Normalize \r\n to \n first, then simulate standalone \r (line overwrite)
  result = result.replace(/\r\n/g, '\n');
  const lines = result.split('\n');
  const resolved = [];
  for (const line of lines) {
    if (line.includes('\r')) {
      // Standalone \r means overwrite — keep only the last segment
      const parts = line.split('\r');
      resolved.push(parts[parts.length - 1]);
    } else {
      resolved.push(line);
    }
  }
  return resolved.join('\n');
}

// Clean PTY output for display: strip ANSI + remove Claude Code UI chrome
function cleanPtyOutput (raw) {
  const stripped = stripAnsi(raw);
  const lines = stripped.split('\n');
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    // Skip empty lines
    if (!trimmed) {
      continue;
    }
    // Skip Claude Code UI: logo, banner, horizontal rules, prompts, status
    if (/^[▐▝▘▛▜█▌▀▄░▒▓\s]+$/.test(trimmed)) {
      continue;
    }
    if (/^[─━═╌┄]+$/.test(trimmed)) {
      continue;
    }
    if (/^❯\s/.test(trimmed)) {
      continue;
    }
    if (/^[⏵⏴]\s*[⏵⏴]?\s*(bypass|auto|plan|permissions?)/i.test(trimmed)) {
      continue;
    }
    if (/^◐\s/.test(trimmed) || /^\s*◐\s/.test(trimmed)) {
      continue;
    }
    if (/Pasting\s*text/i.test(trimmed)) {
      continue;
    }
    if (/^Claude\s*Code\s*v/i.test(trimmed)) {
      continue;
    }
    if (/Opus|Sonnet|Haiku|Claude\s*Max/i.test(trimmed) && trimmed.length < 80) {
      continue;
    }
    if (/shift\+tab\s*to\s*cycle/i.test(trimmed)) {
      continue;
    }
    if (/ctrl\+[a-z]\s+to\s/i.test(trimmed)) {
      continue;
    }
    if (/^Try\s*"/.test(trimmed)) {
      continue;
    }
    // Skip lines that are mostly box-drawing or block chars (>50%)
    const specialChars = (trimmed.match(/[▐▝▘▛▜█▌▀▄░▒▓─━═╌┄│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬]/g) || []).length;
    if (specialChars > trimmed.length * 0.5) {
      continue;
    }
    cleaned.push(trimmed);
  }
  return cleaned.join('\n');
}

export { escapeHtml, stripAnsi, cleanPtyOutput };
