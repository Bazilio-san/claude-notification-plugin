#!/usr/bin/env node

const POLL_TIMEOUT = 30; // seconds
const MAX_MESSAGE_LENGTH = 4096;

export class TelegramPoller {
  constructor (token, chatId, logger) {
    this.token = token;
    this.chatId = String(chatId);
    this.logger = logger;
    this.baseUrl = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
    this._errorBackoff = 0; // current backoff in ms (0 = no backoff)
    this._consecutiveErrors = 0;
  }

  async flush () {
    try {
      const url = `${this.baseUrl}/getUpdates?offset=-1&timeout=0&allowed_updates=["message"]`;
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
      const url = `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message"]`;
      const res = await fetch(url, { signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000) });
      const data = await res.json();
      if (!data.ok) {
        this.logger.error(`getUpdates failed: ${JSON.stringify(data)}`);
        this._applyBackoff();
        return [];
      }
      // Success — reset backoff
      if (this._consecutiveErrors > 0) {
        this.logger.info('getUpdates recovered after errors');
      }
      this._consecutiveErrors = 0;
      this._errorBackoff = 0;

      const messages = [];
      for (const update of data.result || []) {
        this.offset = update.update_id + 1;
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

  async sendMessage (text, replyToMessageId) {
    const chunks = splitMessage(text);
    let firstMessageId = null;
    for (const chunk of chunks) {
      try {
        const body = {
          chat_id: this.chatId,
          text: chunk,
          parse_mode: 'HTML',
        };
        if (replyToMessageId) {
          body.reply_to_message_id = replyToMessageId;
        }
        const res = await fetch(`${this.baseUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.ok) {
          // Retry without HTML parse mode
          const res2 = await fetch(`${this.baseUrl}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: this.chatId,
              text: chunk,
              ...(replyToMessageId ? { reply_to_message_id: replyToMessageId } : {}),
            }),
          });
          const data2 = await res2.json();
          if (data2.ok && !firstMessageId) {
            firstMessageId = data2.result.message_id;
          }
        } else if (!firstMessageId) {
          firstMessageId = data.result.message_id;
        }
      } catch (err) {
        this.logger.error(`sendMessage error: ${err.message}`);
      }
    }
    return firstMessageId;
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

  // Split into chunks preserving line boundaries
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) {
      splitAt = MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt + 1);
  }
  return chunks;
}

// Strip ANSI escape codes and terminal control sequences from PTY output
function stripAnsi (text) {
  return text
    // CSI sequences: \x1b[ followed by optional ?/>/! prefix, params, and terminator
    .replace(/\x1b\[[?>=!]?[0-9;]*[a-zA-Z~]/g, '')
    // OSC sequences: \x1b] ... (terminated by BEL or ST)
    .replace(/\x1b][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // Other two-char escape sequences (\x1b followed by any single char)
    .replace(/\x1b[^[\]]/g, '')
    // Carriage returns (overwrite lines)
    .replace(/\r/g, '')
    // Remaining control chars except newline and tab
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
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
