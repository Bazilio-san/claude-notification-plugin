---
name: listener-debug
description: "Diagnose and recover a stuck Claude Code Telegram listener — hangs, missing replies, queue blocked, PTY frozen, hook signals lost. Inspects state files, logs, PTY sessions; cancels/clears/restarts as needed; and (if a code bug is found) patches the listener, publishes a new version, reinstalls globally, restarts. Triggers: 'процесс завис', 'листнер завис', 'листнер не отвечает', 'бот не отвечает', 'задача висит', 'не вижу ответа от листнера', 'отправил команду но ничего не пришло', 'дебаг листнера', 'задебажь листнер', 'почини листнер', 'listener stuck', 'listener hung', 'task hung', 'no response from bot', 'debug the listener'."
---

# Listener Debug

Triage and fix a hung Claude Code Telegram Listener: the user sent a task to `&<alias>` and the bot stopped responding.

## How to use this skill

1. Confirm the **project alias** the user mentioned (e.g. `&abc`). If not given — ask once, then proceed.
2. **Gather facts** (read files in parallel — see "Snapshot" below).
3. **Diagnose** by matching symptoms to "Symptom → Likely cause → Action" below.
4. Apply the **least-destructive recovery** that fits, escalating only if the lower step fails: `/pty` look → `/cancel` → `/clear` → `listener restart` → code fix + publish.
5. If a real bug is in `listener/*.js` or `bin/listener-cli.js`, follow "Fix-publish-restart cycle".

Always tell the user *what* you observed before *what* you'll do.

## Snapshot — gather these facts FIRST (run in parallel)

These reads are all read-only and cheap. Run them together before drawing conclusions.

```bash
# 1. Daemon alive?
claude-notify listener status

# 2. Resolve log dir from config (logDir / taskLogDir may be customized)
cat ~/.claude/claude-notify.config.json
#   → look at: listener.logDir, listener.taskLogDir, listener.projects.<alias>.path,
#              listener.taskTimeoutMinutes, listener.continueSession

# 3. Queue & active task for the workDir
cat ~/.claude/.task_queues.json
#   → find the entry whose "project" matches the alias; check active + queue.length

# 4. Pending hook signals from PTY sessions
ls ~/.claude/pty-signals/
#   → rdy_<sid>.json (SessionStart) — should be cleaned up after start
#   → act_<sid>.json (PostToolUse, last activity, overwritten)
#   → cmp_<sid>.json (PostCompact)
#   → err_<sid>.json (StopFailure — API errors)
#   → <sid>.json    (Stop signal — completion)
#   Stale files older than the active task's startedAt indicate a cwd-mismatch
#   or a daemon that wasn't running when Claude finished.

# 5. Operational log (last 80 lines is usually enough)
tail -80 <logDir>/.cc-n-listener.log
#   logDir defaults to ~/.claude; in this user's setup it's D:/logs

# 6. Q&A log for the project (last question + answer for the alias)
tail -120 <logDir>/.cc-n-task-<alias>.log

# 7. Raw PTY transcript — what Claude is actually doing in the terminal
tail -200 <logDir>/<alias>_<branch>_pty.log
#   branch defaults to "main"; e.g. noti_main_pty.log
```

The most informative single check is `<logDir>/<alias>_main_pty.log` — it shows whether Claude is working, waiting, idle at a prompt, or crashed. Pair it with `.cc-n-listener.log` to see what the daemon thinks is happening.

For a richer in-Telegram view, ask the user to send `/pty &<alias>` to the bot — it returns state, buffer size, elapsed time, live-console status, and last 15 lines of cleaned output. Faster than asking them to share log snippets.

## Symptom → likely cause → action

### A. Bot accepted the task (`⏳ Running…` arrived) but never sent a result

Most common scenarios — check in this order:

1. **PTY process exited early** — log shows `PTY exited in <workDir> with code N` or `PTY process exited unexpectedly`.
   - Action: `claude-notify listener restart`. Watchdog clears the stale `active` task on next start. Then user retries the task.

2. **`AttachConsole failed` from node-pty** (Windows only, `_logs` shows it) — known node-pty cleanup error after process exit.
   - Already handled by `uncaughtException` guard in `listener.js:31`. If listener is still up, it's harmless. If listener died, `restart`.

3. **Stop hook never fired** — pty log shows Claude printed an answer but `pty-signals/<sessionId>.json` was never created.
   - Verify hooks are installed: `cat ~/.claude/settings.json` → look for `Stop` hook calling `claude-notify`.
   - If missing: re-run `claude-notify install`.
   - The marker waiter is **inactivity-based** (`pty-runner.js:216`): if PTY keeps emitting bytes, it never times out. So an answer that finished + an idle prompt + no Stop signal will hang for the full `taskTimeoutMinutes` (default 30). User should `/cancel &<alias>` to break out.

4. **Hook signal `cwd` mismatch** — `pty-signals/` contains a fresh `.json` for the right session, but the daemon ignored it.
   - Cause: `marker.cwd` doesn't normalize-match `session.workDir` (`pty-runner.js:196`: lowercase + forward slashes, trailing slash stripped). If the project path in config differs in case/separators from what Claude reports as `cwd`, signals are silently skipped.
   - Fix: edit `~/.claude/claude-notify.config.json` so `listener.projects.<alias>.path` exactly matches the canonical path Claude uses (Windows: drive letter case + backslashes are tolerated; only resolved+lowercased paths must match).

5. **Listener daemon is dead** — `listener status` says "not running" or "stale PID".
   - Action: `claude-notify listener restart`. Active tasks in queues are cleared by watchdog; queued tasks are preserved.

6. **Trust prompt blocked startup** — pty log shows `Do you trust the files in this folder?` and nothing after.
   - The runner auto-answers with `\r` (`pty-runner.js:545`). If the prompt phrasing changed, detection in `_waitForReady` may miss it.
   - User workaround: `/cancel &<alias>`, then once: open `claude` in that folder manually, say yes, exit. Listener will work after that.

### B. Bot replied `📋 Queued (position N)` and never moved

Active task in that workDir is stuck. Look at `task_queues.json` → `active.startedAt`, compare to now.
- If elapsed > `taskTimeoutMinutes` → watchdog should have caught it; if it didn't, `restart` triggers cleanup.
- Otherwise: `/cancel &<alias>` to drop the active and start the next one. If queue is also wrong, `/clear &<alias>` (also resets session).

### C. Bot didn't reply at all (no `⏳ Running…`)

The message never reached the listener.
- `chatId` mismatch — listener log shows `WARN Ignored message from chat <id>`. Fix `telegram.chatId` in config.
- Long-poll conflict (`409 Conflict` in log) — two listeners or a stale getUpdates session. `restart` is idempotent (kills prior PID before starting).
- Token revoked / network — log shows `getUpdates` errors. Check token, then `restart`.

### D. Live console (`⏳ Running…` message) keeps updating but never finishes

PTY is alive and emitting output, marker watcher inactivity is being reset by activity. Either Claude is genuinely working or stuck in a tool loop.
- `/pty &<alias>` shows last 15 lines. If they're meaningful → wait. If it's a stuck spinner or repeated tool calls → `/cancel &<alias>`.

### E. "Failed to create PTY session" / Claude not found

`claude` binary not on PATH for the daemon's environment, or `node-pty` failed to load.
- Check: `claude --version` from a fresh shell.
- On Windows: the daemon spawns via `cmd.exe /c claude` (`pty-runner.js:460`); PATH must include the shim directory.
- `npm install -g claude-notification-plugin` to re-run postinstall, then `restart`.

## Recovery actions (escalation ladder)

Use the lowest one that resolves the symptom.

| Action | Side effect | When to use |
|---|---|---|
| Wait for live-console update | None | Output looks alive — Claude is busy |
| `/pty &<alias>` (Telegram) | None | Need a 1-shot diagnostic |
| `/cancel &<alias>` (Telegram) | Kills active PTY in that workDir; next queued task starts | Active task is genuinely stuck |
| `/clear &<alias>` (Telegram) | Kills active + drops queue + resets session | Queue is full of wrong tasks or session is corrupted |
| `/newsession &<alias>` (Telegram) | Resets session for next task; queue + active untouched | Context window full, Claude going in circles |
| `claude-notify listener restart` | Kills daemon; watchdog clears stale `active` on start; queues preserved | Daemon-wide problem (multiple workDirs stuck, log shows crashes, status says dead) |
| Edit config + `restart` | Same as above | Misconfigured `chatId`/`token`/`projects.<alias>.path` |
| Code fix + publish + reinstall + `restart` | New global package version | Real bug found in `listener/*.js` or `bin/listener-cli.js` |

For the user to run a Telegram command, ask them to send it. If they want it automated, invoke the **`test-telegram`** skill (it sends messages via Playwright on Telegram Web).

## Fix-publish-restart cycle (when code change is needed)

Follow this exact sequence — the project's `CLAUDE.md` codifies it as the dev/test cycle.

1. **Edit** in `listener/` or `bin/` — keep the change minimal and targeted at the diagnosed cause.
2. **Lint** `npm run lint` — must pass.
3. **Publish**: `node scripts/publish.js`
   - Reads current version from `package.json`.
   - Auto-bumps patch if version unchanged since last tag.
   - Syncs version to `.claude-plugin/plugin.json`.
   - Commits, tags `v<version>`, pushes commit + tag.
   - Publishes to npm.
4. **Wait ~60s** for npm registry propagation.
5. **Reinstall globally**: `npm install -g claude-notification-plugin@<version>` (use the version printed by step 3).
6. **Restart**: `claude-notify listener restart`.
7. **Verify**: ask user to retry the failing scenario, or trigger via `/test-telegram` skill. Watch `<logDir>/.cc-n-listener.log` and `<logDir>/<alias>_main_pty.log` live.
8. If still broken — go back to step 1. Don't accumulate untested fixes.

Code changes that affect the user-facing surface (env vars, CLI, config keys, hook events) **must** also update `README.md` — this is in `CLAUDE.md` Maintenance Rules.

## Where the moving parts live

| Concern | File |
|---|---|
| Daemon entry & command routing | `listener/listener.js` |
| Daemon lifecycle (start/stop/status) | `bin/listener-cli.js` |
| Claude PTY session, marker watching, timeouts | `listener/pty-runner.js` |
| Per-workDir FIFO queue, persistence, watchdog | `listener/work-queue.js` |
| Telegram long-polling, send/split | `listener/telegram-poller.js` |
| `&proj/branch` and `/cmd` parsing | `listener/message-parser.js` |
| Worktree resolve / auto-create | `listener/worktree-manager.js` |
| JSONL session reader (live console source) | `listener/jsonl-reader.js` |
| Notifier (writes hook signal files) | `notifier/notifier.js` |
| Path constants, config helpers | `bin/constants.js` |

Hook signal types and their meanings are documented in `listener/LISTENER-DETAILED.md` § "Hook-based communication".

## Things that are NOT bugs but look like hangs

- **`continueSession: true`** keeps the same PTY alive between tasks. Long task #5 in a row may degrade because context window is filling — check `ctx N%` in the previous completion message; `/newsession &<alias>` if >80%.
- **`taskTimeoutMinutes`** is **inactivity-based**, not absolute. A task that emits PTY bytes every few seconds can run for hours. Default is 30 min of *silence*, not 30 min total.
- **Slash commands** sent as raw text (`%cmd`) intentionally don't trigger Stop hooks; the runner falls back to 8s inactivity (`pty-runner.js:12`). Brief wait is normal.
- **Two parallel tasks for the same `&alias`** — `task2` queues until `task1` completes. This is correct behavior (one Claude per workDir). Worktrees (`&alias/branch`) run in parallel.
