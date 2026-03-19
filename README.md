# Your remote control for Anthropic Claude Code

**Send a message in Telegram, and the task starts running on your PC.**

Cross-platform notifications for Claude Code task completion.
Sends alerts to Telegram and desktop (Windows, macOS, Linux) when Claude finishes working.


## Features

- **[Telegram Listener](#telegram-listener)** — your remote control for Claude (supports worktrees)
- Telegram bot messages with auto-delete
- Webhook notifications (any URL endpoint)
- Desktop notifications (Windows toast, macOS Notification Center, Linux notify-send)
- Sound alert
- Voice announcement
- Separate notifications for task completion and waiting-for-input events
- Skips short tasks (< 15s by default)
- Per-channel enable/disable (globally and per-project)

## Telegram Setup

If you plan to work with Telegram, you need to pre-register the bot and send a message to it

1. Open Telegram, find **@BotFather**
2. Send `/newbot`, follow prompts, pick a name
3. Copy the bot token (format: `123456789:ABCdef...`)
4. **Send any message to your new bot**

## Install

```bash
npm install -g claude-notification-plugin --foreground-scripts
```

## Setup

If npm install was run without the --foreground-scripts switch, or if you need to reconfigure
The installer prompts for Telegram bot credentials and sets everything up.

```bash
claude-notify install
```

## Uninstall

```bash
claude-notify uninstall
```

This removes hooks, config, CLI wrappers, plugin registration, and the npm global package.

## Configuration

Config file: `~/.claude/claude-notify.config.json`

```json
{
  "telegram": {
    "enabled": true,
    "token": "YOUR_BOT_TOKEN",
    "chatId": "YOUR_CHAT_ID",
    "deleteAfterHours": 24,
    "includeLastCcMessageInTelegram": true
  },
  "desktopNotification": {
    "enabled": true
  },
  "sound": {
    "enabled": true,
    "file": ""
  },
  "voice": {
    "enabled": true
  },
  "webhookUrl": "",
  "sendUserPromptToWebhook": false,
  "notifyAfterSeconds": 15,
  "notifyOnWaiting": false,
  "debug": false,
  "listener": {
    "projects": {
      "default": {
        "path": "abs-path-to-project"
      },
      "alias1": {
        "path": "abs-path-to-project"
      }
    },
    "worktreeBaseDir": "abs-path-to-worktrees-root",
    "autoCreateWorktree": true,
    "taskTimeoutMinutes": 30,
    "maxQueuePerWorkDir": 10,
    "maxTotalTasks": 50,
    "logDir": "abs-path-to-listener-logs",
    "taskLogDir": "abs-path-to-task-logs"
  }
}
```

Environment variables override config values (`"1"` = on, `"0"` = off).

**telegram.enabled** — Enable Telegram messages. Default: **true**
ENV: `CLAUDE_NOTIFY_TELEGRAM`

**telegram.token** — Bot token from @BotFather.
ENV: `CLAUDE_NOTIFY_TELEGRAM_TOKEN`

**telegram.chatId** — Chat ID to send messages to.
ENV: `CLAUDE_NOTIFY_TELEGRAM_CHAT_ID`

**telegram.deleteAfterHours** — Auto-delete old Telegram messages after N hours. `0` to disable. Default: **24**

**telegram.includeLastCcMessageInTelegram** — Append Claude's last message to the notification (truncated to 3500 chars). Default: **true**
ENV: `CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM`

**desktopNotification.enabled** — Desktop notifications. Default: **true**
ENV: `CLAUDE_NOTIFY_DESKTOP`

**sound.enabled** — Sound alert on task completion. Default: **true**
ENV: `CLAUDE_NOTIFY_SOUND`

**sound.file** — Custom sound file path. Default: **platform default**

**voice.enabled** — Voice announcement (TTS) with duration. Default: **true**
ENV: `CLAUDE_NOTIFY_VOICE`

**notifyOnWaiting** — Notify when Claude is waiting for input. Default: **false**
ENV: `CLAUDE_NOTIFY_WAITING`

**webhookUrl** — POST notification JSON to this URL. Payload: `title`, `project`, `branch`, `duration`, `trigger`, `voicePhrase`, `hookEvent`.
ENV: `CLAUDE_NOTIFY_WEBHOOK_URL`

**sendUserPromptToWebhook** — Also send user prompts to the webhook. Requires `webhookUrl`. Default: **false**
ENV: `CLAUDE_NOTIFY_SEND_USER_PROMPT_TO_WEBHOOK`

**notifyAfterSeconds** — Skip notifications for tasks shorter than this. Default: **15**
ENV: `CLAUDE_NOTIFY_AFTER_SECONDS`

**debug** — Include trigger event type and full hook event JSON in notifications. Default: **false**
ENV: `CLAUDE_NOTIFY_DEBUG`

**CLAUDE_NOTIFY_DISABLE** — Set to `1` to disable all notifications for the current project.

**CLAUDE_NOTIFY_AFTER_LISTENER** — Enable notifier notifications for listener-spawned tasks (suppressed by default to avoid duplicates). Set to `1` to enable.

### Per-project configuration

Add to `.claude/settings.local.json` in the project root:

```json
{
  "env": {
    "CLAUDE_NOTIFY_DISABLE": 0,
    "CLAUDE_NOTIFY_TELEGRAM": 1,
    "CLAUDE_NOTIFY_DESKTOP": 1,
    "CLAUDE_NOTIFY_SOUND": 1,
    "CLAUDE_NOTIFY_VOICE": 1,
    "CLAUDE_NOTIFY_WAITING": 1,
    "CLAUDE_NOTIFY_DEBUG": 0,
    "CLAUDE_NOTIFY_INCLUDE_LAST_CC_MESSAGE_IN_TELEGRAM": 1,
    "CLAUDE_NOTIFY_WEBHOOK_URL": "",
    "CLAUDE_NOTIFY_SEND_USER_PROMPT_TO_WEBHOOK": 0,
    "CLAUDE_NOTIFY_AFTER_SECONDS": 15
  }
}
```

## Telegram Listener

Background daemon that receives tasks from Telegram and executes them via `claude -p`. The result is sent back to Telegram.

The Listener uses the same bot and `chatId` as notifications.

### 1. Configure the listener

Run the interactive setup wizard:

```bash
claude-notify listener setup
```

Alternatively, add a `listener` section to config manually:

```json
{
  "listener": {
    "projects": {
      "default": { "path": "/home/user/my-project" },
      "api": { "path": "/home/user/projects/api-server" },
      "web": { "path": "/home/user/projects/web-app" }
    }
  }
}
```

The `"default"` alias receives messages without a `@project` prefix.
`api` and `web` are project aliases for easy reference from Telegram.

### 2. Start the listener

```bash
claude-notify listener start
```

### 3. Send tasks from Telegram

```
fix the login bug                     → runs in "default" project
@api add pagination to GET /users     → runs in "api" project
@api/feature/auth implement OAuth2    → runs in a worktree (auto-created)
```

The bot replies with status and results:

```
⏳ [@api] Running: add pagination to GET /users
...
✅ [@api] Done: add pagination to GET /users
<claude's output>
```

### 4. Manage the daemon

```bash
claude-notify listener status         # Check if running
claude-notify listener stop
claude-notify listener restart
claude-notify listener logs           # View last 50 log lines
claude-notify listener setup          # Interactive listener configuration
```

### 5. Bot commands

All commands start with `/` and execute instantly (not queued).

| Command                       | Description                          |
|-------------------------------|--------------------------------------|
| `/status`                     | Status of all projects and worktrees |
| `/status @project`            | Status of a specific project         |
| `/queue`                      | Show all queues                      |
| `/cancel @project[/branch]`   | Cancel the active task               |
| `/drop @project N`            | Remove task N from queue             |
| `/clear @project[/branch]`    | Clear queue                          |
| `/projects`                   | List projects and paths              |
| `/worktrees @project`         | List worktrees                       |
| `/worktree @project branch`   | Create a worktree                    |
| `/rmworktree @project branch` | Remove a worktree                    |
| `/history`                    | Recent task history                  |
| `/stop`                       | Stop the listener                    |
| `/help`                       | Show help                            |

### Listener configuration

| Parameter            | Default               | Description                                         |
|----------------------|-----------------------|-----------------------------------------------------|
| `projects`           | (required)            | Map of projects: `alias → { path }`                 |
| `worktreeBaseDir`    | `~/.claude/worktrees` | Where auto-created worktrees are stored              |
| `autoCreateWorktree` | `true`                | Auto-create worktrees for unknown branches           |
| `taskTimeoutMinutes` | `30`                  | Max task execution time (force-stopped when exceeded)|
| `maxQueuePerWorkDir` | `10`                  | Max tasks in queue per working directory              |
| `maxTotalTasks`      | `50`                  | Max tasks across all queues                          |
| `logDir`             | `~/.claude`           | Listener log directory                               |
| `taskLogDir`         | same as `logDir`      | Task Q&A log directory                               |

### Projects and worktrees

**The queue is tied to the working directory, not the project name:**
- `@api task` and `@api/feature/auth task` → **different queues** (parallel)
- `@api task1` and `@api task2` → **same queue** (sequential)

Worktrees are auto-created when you use `@project/branch` syntax (controlled by `autoCreateWorktree`).

```
/worktree @api feature/payments     ← create
/worktrees @api                     ← list
/rmworktree @api feature/payments   ← remove
```


[Detailed Guide](listener/LISTENER-DETAILED.md) — internals, architecture, troubleshooting, full session example.


## Manual Telegram bot chatId retrieval:

- Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
- Find `"chat":{"id":123456789}` in the response — that's your Chat ID

Alternative: add **@userinfobot** to a chat and it will reply with the ID.


## CLI Commands

```
claude-notify install              Reinstall plugin registration, Telegram config, hooks
claude-notify uninstall            Remove plugin, hooks, config, CLI wrappers
claude-notify listener <action>    Manage the Telegram Listener daemon
                                   Actions: start, stop, status, setup, logs, restart
```

## License

MIT
