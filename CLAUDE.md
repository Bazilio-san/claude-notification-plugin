# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A cross-platform Claude Code hooks plugin that sends notifications (Telegram, desktop toast, sound, voice) when Claude finishes a task. Supports Windows, macOS, and Linux. Distributed as a global npm package with automatic postinstall, and as a Claude Code plugin (`.claude-plugin/plugin.json` + `hooks/hooks.json`).

## Commands

```bash
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
```

No test framework is configured. No build step — source JS is shipped directly.

## Architecture

Single `bin` entry in package.json:

- **`bin/cli.js`** (`claude-notify`) — Unified entry point. Subcommands: `install`, `uninstall`, `listener <action>`. When called with no args and stdin piped (hook mode), delegates to `notifier/notifier.js` which reads JSON from stdin (Claude hook event), manages a timer via state file, and dispatches notifications.

Supporting modules (not in `bin`, called by the dispatcher):
- **`bin/install.js`** — Plugin registration, Telegram config, hooks, CLI wrapper. Also runs as `postinstall`.
- **`bin/uninstall.js`** — Cleanup: hooks, config, wrapper, plugin cache, `installed_plugins.json`, npm global package. Called via `claude-notify uninstall`.
- **`bin/listener-cli.js`** — Telegram Listener daemon management (start/stop/status/logs/restart).

### Dynamic version resolver

A CLI wrapper script (created next to the `claude` binary) calls `~/.claude/claude-notify-resolve.js` — a small CJS script that reads `installed_plugins.json` at runtime to find the current `installPath` and forwards execution. This ensures the wrapper survives plugin version updates.

## Publish Workflow

When the user says "опубликуй", "опубликуй проект", or "publish":

1. Read current version from `package.json`
2. Run `git add -A && git status` — if there are staged changes, commit them with a descriptive message
3. Compare the version in `package.json` with the last git tag. If the version has NOT changed, increment the patch number (e.g. 1.0.4 → 1.0.5), update both `package.json` and `.claude-plugin/plugin.json`, and amend the commit (`git commit --amend --no-edit`)
4. Create a git tag `v<version>` and push both the commit and the tag: `git push && git push --tags`

## Key Details

- ESM modules (`"type": "module"` in package.json), Node >= 18
- npm lifecycle script: `postinstall` runs `bin/install.js`. Uninstall via `claude-notify uninstall` (npm doesn't run preuninstall for global packages)
- Config file: `~/.claude/claude-notify.config.json` — env vars `CLAUDE_NOTIFY_TELEGRAM_TOKEN` / `CLAUDE_NOTIFY_TELEGRAM_CHAT_ID` override config
- Per-project disable via `CLAUDE_NOTIFY_DISABLE=1` env var
- Per-channel env overrides: `CLAUDE_NOTIFY_TELEGRAM`, `CLAUDE_NOTIFY_DESKTOP`, `CLAUDE_NOTIFY_SOUND`, `CLAUDE_NOTIFY_VOICE`, `CLAUDE_NOTIFY_WAITING`, `CLAUDE_NOTIFY_DEBUG`, `CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM` (`1`/`0`), `CLAUDE_NOTIFY_WEBHOOK_URL` (URL string, empty string to disable), `CLAUDE_NOTIFY_AFTER_SECONDS` (number), `CLAUDE_NOTIFY_AFTER_LISTENER` (`1`/`0`)
- Dependencies: `node-notifier` (cross-platform desktop notifications with native fallback). Sound: PowerShell (Windows), afplay (macOS), paplay/aplay (Linux). Voice: SAPI (Windows), say (macOS), spd-say/espeak (Linux)
- Plugin format: `.claude-plugin/plugin.json` (manifest) + `hooks/hooks.json` (hook config with `${CLAUDE_PLUGIN_ROOT}`)
- Version must be kept in sync between `package.json` and `.claude-plugin/plugin.json` (pre-commit hook and `scripts/publish.js` handle this)
- ESLint: single quotes, 2-space indent, semicolons required, space before function parens, `1tbs` brace style

## Markdown Editing Rules

- **Preserve trailing double spaces** in `.md` files. Two spaces at the end of a line (`  `) create a line break in Markdown. When editing, never strip or lose these trailing spaces — without them, lines will merge into a single paragraph.

## Code Style Rules

- **No consecutive `console.log` calls.** Use a single `console.log` with a template literal (backtick multiline string) instead of multiple `console.log` calls in a row. Example:
  ```js
  // Bad
  console.log('Line 1');
  console.log('Line 2');
  console.log('Line 3');

  // Good
  console.log(`Line 1
  Line 2
  Line 3`);
  ```

- **No multiline string concatenation.** Use template literals instead of concatenating strings with `+` and `\n`. Example:
  ```js
  // Bad
  return '<b>Title</b>\n'
    + '\n/cmd1 — description'
    + '\n/cmd2 — description';

  // Good
  return `<b>Title</b>

  /cmd1 — description
  /cmd2 — description`;
  ```

## Testing via Playwright + Telegram Web

For E2E testing of Telegram bot interactions, use Playwright MCP with Telegram Web.

### Bot identity: `bot_name.local.txt`

Bot title and username are stored in `bot_name.local.txt` (gitignored via `*.local.*`).
Format — two lines:
```
<Bot Title>
<bot_username>
```

The username is stored **without** the `@` prefix. Example:
```
ClaudeCode
noticc_bot
```

**If the file does not exist**, ask the user for both values before proceeding with any Telegram Web test. When the user provides the username, strip the leading `@` if present. Save the file immediately.

Use these values to build the Telegram Web URL: `https://web.telegram.org/k/#@<bot_username>`
and to locate the chat by `<Bot Title>` in the chat list.

### Prerequisites

1. `bot_name.local.txt` exists (or ask the user — see above)
2. Telegram Web must be authorized (QR-code scan on first run; Playwright caches the session)
3. Listener must be running: `claude-notify listener restart`
4. Projects configured in `~/.claude/claude-notify.config.json`

### Sending messages to bot

The message input in Telegram Web is a `contenteditable div`, NOT `<input>` or `<textarea>`. Standard `fill` does not work.

```
1. Read bot_name.local.txt → get <bot_username>
2. browser_navigate → https://web.telegram.org/k/#@<bot_username>
3. browser_snapshot → find input field (ref with "Message")
4. browser_click(ref) → click the input container
5. browser_type(ref, text, slowly: true) → type text char-by-char
6. browser_press_key("Enter") → send
```

### Waiting for bot response

```
1. browser_wait_for(time: N) → wait N seconds (simple: 30-60s, complex: 120-300s)
2. browser_snapshot → find new bot messages
3. Look for markers: ⏳ "Running..." (accepted), ✅/❌ (completed)
```

### Emulating hook events (without listener)

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

### Key fields

- Hook event field: `hook_event_name` (not `hook_type`), values: `Stop`, `UserPromptSubmit`, `Notification`
- Notifier requires prior `UserPromptSubmit` to start session timer; without it, `duration=0 < notifyAfterSeconds` → silent exit. Use `CLAUDE_NOTIFY_AFTER_SECONDS=0` to bypass.

### Debugging

```bash
tail -20 D:/logs/.cc-n-listener.log          # Listener logs
cat ~/.claude/.notifier_state.json            # Notifier state
ls ~/.claude/pty-signals/                     # PTY marker files
cat D:/logs/default_main_pty.log              # PTY raw output for default project
```

## Maintenance Rules

- After any user-facing code changes (new features, config options, env vars, CLI behavior), update `README.md` to reflect them
