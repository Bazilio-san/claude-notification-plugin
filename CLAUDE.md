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
- Per-channel env overrides: `CLAUDE_NOTIFY_TELEGRAM`, `CLAUDE_NOTIFY_DESKTOP`, `CLAUDE_NOTIFY_SOUND`, `CLAUDE_NOTIFY_VOICE`, `CLAUDE_NOTIFY_WAITING`, `CLAUDE_NOTIFY_DEBUG`, `CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM` (`1`/`0`), `CLAUDE_NOTIFY_WEBHOOK_URL` (URL string), `CLAUDE_NOTIFY_SEND_USER_PROMPT_TO_WEBHOOK` (`1`/`0`), `CLAUDE_NOTIFY_AFTER_SECONDS` (number), `CLAUDE_NOTIFY_AFTER_LISTENER` (`1`/`0`)
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

## Maintenance Rules

- After any user-facing code changes (new features, config options, env vars, CLI behavior), update `README.md` to reflect them
