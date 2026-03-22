# Notifier Hook Events - Detailed Guide

The notifier (`notifier/notifier.js`) is the plugin's hook handler — a single script invoked by Claude Code for every registered hook event. It reads JSON from stdin, determines the event type and operating mode, and dispatches accordingly.

## Operating modes

| Mode | Condition | Behavior |
|---|---|---|
| **Disabled** | `CLAUDE_NOTIFY_DISABLE=1` | Exit immediately |
| **Listener-only** | `CLAUDE_NOTIFY_FROM_LISTENER=1` (and `CLAUDE_NOTIFY_AFTER_LISTENER` not `1`) | Write signal files to `~/.claude/pty-signals/`, no user notifications |
| **Normal** | Default | Send notifications (Telegram, desktop, sound, voice, webhook) |

## Hook events

| Hook Event | Mode | Sync | Purpose |
|---|---|---|---|
| `UserPromptSubmit` | Normal | sync | Starts the notification timer (records session start time) |
| `Stop` | Both | sync | Normal: sends completion notification. Listener: writes completion signal file |
| `StopFailure` | Both | async | Normal: sends error notification. Listener: writes error signal file |
| `Notification` | Normal | sync | Sends waiting-for-input notification (when `notifyOnWaiting` is enabled) |
| `SessionStart` | Listener | async | Writes session ready signal (model name, startup/resume source) |
| `PermissionRequest` | Listener | sync | Auto-approves permission prompts via JSON output to stdout |
| `PostToolUse` | Listener | async | Writes tool activity signal (tool name, input parameters) |
| `PostCompact` | Listener | async | Writes context compaction signal (summary, trigger type) |

**Sync** hooks block Claude until the script completes (Claude waits for the response).
**Async** hooks run in the background (Claude continues immediately).

## Normal mode flow

```
UserPromptSubmit
  → Record session start time in state file
  → Send webhook (if configured)

Stop / StopFailure / Notification
  → Check elapsed time since session start
  → Skip if duration < notifyAfterSeconds (default 15s)
  → Build notification text (project, branch, duration, last message)
  → Send: Telegram, desktop toast, sound, voice, webhook
  → Clean up old Telegram messages (deleteAfterHours)
```

## Listener-only mode flow

```
PermissionRequest
  → Output auto-approve JSON to stdout:
    { hookSpecificOutput: { hookEventName: "PermissionRequest",
      decision: { behavior: "allow" } } }

Stop
  → Write ~/.claude/pty-signals/{sessionId}.json
    { sessionId, cwd, lastAssistantMessage, cost, numTurns, durationMs }

StopFailure
  → Write ~/.claude/pty-signals/err_{sessionId}.json
    { type: "error", cwd, error, errorDetails, lastAssistantMessage }

SessionStart
  → Write ~/.claude/pty-signals/rdy_{sessionId}.json
    { type: "ready", cwd, model, source }

PostToolUse
  → Write ~/.claude/pty-signals/act_{sessionId}.json (overwritten each call)
    { type: "activity", cwd, toolName, toolInput }

PostCompact
  → Write ~/.claude/pty-signals/cmp_{sessionId}.json
    { type: "compact", cwd, summary, trigger }
```

## Configuration

See the main [README](../README.md) for configuration options.

Key settings affecting notifier behavior:
- `notifyAfterSeconds` (default: 15) — minimum task duration to trigger notifications
- `notifyOnWaiting` (default: false) — send notifications for idle/waiting events
- `telegram.includeLastCcMessageInTelegram` (default: true) — include Claude's last message in Telegram notification
- `telegram.deleteAfterHours` (default: 24) — auto-delete old notification messages
- `debug` (default: false) — include hook event JSON and trigger type in notifications
