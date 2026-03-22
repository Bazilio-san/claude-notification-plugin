---
name: test-telegram
description: "E2E testing of Telegram bot and listener via Playwright MCP on Telegram Web. Use when asked to test the listener with Playwright, test in Telegram, verify bot interactions. Triggers: 'тестируй листнер с плейврайт', 'тестируй в телеграм', 'тестируй в телеграм сам', 'протестируй бота в телеграме'."
disable-model-invocation: true
---

# E2E Testing: Listener via Playwright + Telegram Web

Test the Telegram bot listener by interacting with it through Telegram Web using Playwright MCP tools.

## Bot identity: `bot_name.local.txt`

Bot title and username are stored in `bot_name.local.txt` (gitignored via `*.local.*`).
Format — two lines:
```
<Bot Title>
<bot_username>
```

The username is stored **without** the `@` prefix. Example:
```
ClaudeCodeNotify
my_notify_cc_bot
```

**If the file does not exist**, ask the user for both values before proceeding. When the user provides the username, strip the leading `@` if present. Save the file immediately.

Use these values to build the Telegram Web URL: `https://web.telegram.org/k/#@<bot_username>`
and to locate the chat by `<Bot Title>` in the chat list.

## Prerequisites

1. `bot_name.local.txt` exists (or ask the user — see above)
2. Telegram Web must be authorized (QR-code scan on first run; Playwright caches the session)
3. Listener must be running: `claude-notify listener restart`
4. Projects configured in `~/.claude/claude-notify.config.json`

## Sending messages to bot

The message input in Telegram Web is a `contenteditable div`, NOT `<input>` or `<textarea>`. Standard `fill` does not work.

```
1. Read bot_name.local.txt → get <bot_username>
2. browser_navigate → https://web.telegram.org/k/#@<bot_username>
3. browser_snapshot → find input field (ref with "Message")
4. browser_click(ref) → click the input container
5. browser_type(ref, text, slowly: true) → type text char-by-char
6. browser_press_key("Enter") → send
```

## Waiting for bot response

```
1. browser_wait_for(time: N) → wait N seconds (simple: 30-60s, complex: 120-300s)
2. browser_snapshot → find new bot messages
3. Look for markers: ⏳ "Running..." (accepted), ✅/❌ (completed)
```

## Emulating hook events (without listener)

```bash
# 1. Send UserPromptSubmit (starts timer)
echo '{"hook_event_name":"UserPromptSubmit","session_id":"e2e-001","cwd":"/path"}' | \
  CLAUDE_NOTIFY_AFTER_SECONDS=0 CLAUDE_NOTIFY_DESKTOP=0 CLAUDE_NOTIFY_SOUND=0 CLAUDE_NOTIFY_VOICE=0 \
  node notifier/notifier.js

# 2. Wait for duration
sleep 2

# 3. Send Stop (triggers notification)
echo '{"hook_event_name":"Stop","session_id":"e2e-001","cwd":"/path","last_assistant_message":"Test result"}' | \
  CLAUDE_NOTIFY_AFTER_SECONDS=0 CLAUDE_NOTIFY_DESKTOP=0 CLAUDE_NOTIFY_SOUND=0 CLAUDE_NOTIFY_VOICE=0 \
  node notifier/notifier.js
```

**Note**: On Windows, `echo '...' | node` is unreliable with ESM + stdin. Use a temp script with mock Readable via `Object.defineProperty(process, 'stdin', ...)`.

## Key fields

- Hook event field: `hook_event_name` (not `hook_type`), values: `Stop`, `UserPromptSubmit`, `Notification`
- Notifier requires prior `UserPromptSubmit` to start session timer; without it, `duration=0 < notifyAfterSeconds` → silent exit. Use `CLAUDE_NOTIFY_AFTER_SECONDS=0` to bypass.

## Debugging

```bash
tail -20 D:/logs/.cc-n-listener.log          # Listener logs
cat ~/.claude/.notifier_state.json            # Notifier state
ls ~/.claude/pty-signals/                     # PTY marker files
cat D:/logs/default_main_pty.log              # PTY raw output for default project
```
