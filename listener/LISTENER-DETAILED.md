# Telegram Listener - Detailed Guide

Telegram Listener is a background daemon that receives tasks from a Telegram chat
and executes them on your machine via an interactive Claude Code PTY session. The result is sent back to Telegram.

**[Quick Start here](../LISTENER.md)**

# Detailed Guide

## Table of Contents

- [What is the Listener](#what-is-the-listener)
- [Long polling: how it works](#long-polling-how-it-works)
- [Detached process: why the listener lives without a terminal](#detached-process-why-the-listener-lives-without-a-terminal)
- [PID file and duplicate protection](#pid-file-and-duplicate-protection)
- [Listener components](#listener-components)
- [Message processing flow](#message-processing-flow)
- [Configuration](#configuration)
- [Sending tasks](#sending-tasks)
- [Projects and worktrees](#projects-and-worktrees)
- [Task queues](#task-queues)
- [Bot commands](#bot-commands)
- [Live console and PTY diagnostics](#live-console-and-pty-diagnostics)
- [Task lifecycle](#task-lifecycle)
- [State files](#state-files)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Full session example](#full-session-example)

---

## What is the Listener

The Listener is **not a web server**. It does not listen on ports, does not accept incoming connections, and does not require a public IP, domain, or SSL.

The Listener is a regular Node.js program that runs an infinite loop:

```
while (true) {
  1. Send an HTTP request to Telegram: "Any new messages?"
  2. Telegram responds: "Yes, here are 3 messages" (or "No, nothing")
  3. Process each message
  4. goto 1
}
```

The Listener fetches data from Telegram itself (outgoing requests), rather than Telegram connecting to it (incoming). That's why it works behind any NAT, firewall, or VPN — from anywhere with internet access.

---

## Long polling: how it works

```
Listener (your computer)              Telegram server
────────────────────────              ──────────────

GET /getUpdates?timeout=30  ────►     "Let's wait up to 30 seconds,
                                       maybe someone will write..."

    (listener hangs and waits,
     connection is open)

                                      After 15 sec a user
                                      wrote "&proj1 fix bug"

◄──── {"result": [{"message":...}]}   "There's a message, here it is!"

Processing... launching claude...

GET /getUpdates?timeout=30  ────►     "Waiting again..."

    (30 seconds of silence, nobody writes)

◄──── {"result": []}                  "Nothing in 30 sec"

GET /getUpdates?timeout=30  ────►     ...and so on in a loop
```

**How `timeout=30` works**: this is not a polling interval of once every 30 seconds. It tells Telegram: "keep the connection open for up to 30 seconds. If a message arrives during this time — respond **immediately**. If not — respond with an empty result."

In practice, delivery latency is:
- If a message arrives while waiting → **instant** (less than a second)
- Worst case (message arrives right after a response) → up to 30 seconds

The `offset` parameter in the request ensures each message is processed exactly once: after receiving messages, the listener remembers `update_id + 1` and passes it in the next request, so Telegram doesn't return already-processed messages.

---

## Detached process: why the listener lives without a terminal

When you run `claude-notify listener start`, the following happens:

```
Your terminal
     │
     └─► listener-cli.js start
              │
              ├─ Check: is it already running?
              ├─ Check config
              │
              ├─ spawn("node listener.js", { detached: true })
              │       │
              │       └─► listener.js ← SEPARATE OS PROCESS
              │           Not attached to the terminal.
              │           Lives on its own.
              │           PID written to ~/.claude/.listener.pid
              │
              ├─ child.unref()  ← "don't wait for child process to finish"
              ├─ console.log("Started PID: 12345")
              └─ exit
     │
     Terminal is free (or closed)

     listener.js continues running.
```

`detached: true` — creates a process not tied to the parent.
`child.unref()` — allows `listener-cli.js` to exit without waiting for the child.

Result: the listener runs as a background OS process. It is not tied to a terminal or to Claude Code — only to the operating system. It will only stop when:
- The `claude-notify listener stop` command is issued (or `/stop` in Telegram)
- The computer is shut down or restarted
- It crashes due to an error

---

## PID file and duplicate protection

The PID file (`~/.claude/.listener.pid`) is simply a text file with the process number:

```
12345
```

Why it's needed:
- **`start`** — check whether the listener is already running
- **`stop`** — determine which process to kill
- **`status`** — show whether it's running and with which PID

### What if the listener crashes but the PID file remains?

This is a normal situation. Every `start` and `status` performs a check:

```
1. Read PID from file → 12345
2. Check: is process 12345 alive?
     Windows: tasklist /FI "PID eq 12345"
     Linux:   kill -0 12345

3a. Process is ALIVE
     → "Listener is already running (PID: 12345)"
     → A new one is not started

3b. Process is DEAD
     → PID file is stale, delete it
     → Start a new listener normally
```

The scenario where the OS reuses the PID for another process is extremely unlikely, and even if it happens, the listener will simply show "already running" and you can delete the PID file manually (`rm ~/.claude/.listener.pid`) and start again.

### Two listener instances

Running two listeners is impossible — the PID file prevents it. And this is important: two listeners on the same bot break long polling. Whichever calls `getUpdates` first gets the messages. The second gets an empty response. Messages would be randomly lost between the two processes.

---

## Listener components

```
┌────────────────────────────────────────────┐
│              listener.js (OS process)      │
│                                            │
│  ┌────────────────┐    ┌───────────────┐   │
│  │ TelegramPoller │    │   WorkQueue   │   │
│  │                │    │ (per-workDir) │   │
│  │ long polling   │    │ active + FIFO │   │
│  │ getUpdates()   │    │ .json on disk │   │
│  │ sendMessage()  │    └───────┬───────┘   │
│  └───────┬────────┘            │           │
│          │                     │           │
│  ┌───────┴────────┐    ┌───────┴───────┐   │
│  │ MessageParser  │    │  PtyRunner    │   │
│  │                │    │               │   │
│  │ &proj/branch   │    │ PTY session   │   │
│  │ /commands      │    │ timeouts      │   │
│  └────────────────┘    │ signal files  │   │
│                        └───────────────┘   │
│  ┌────────────────┐    ┌───────────────┐   │
│  │WorktreeManager │    │    Logger     │   │
│  │                │    │               │   │
│  │ git worktree   │    │ .log file     │   │
│  │ add/remove     │    │ rotation 5MB  │   │
│  │ auto-discover  │    └───────────────┘   │
│  └────────────────┘                        │
└────────────────────────────────────────────┘
```

| Module | File | Description |
|---|---|---|
| **TelegramPoller** | `telegram-poller.js` | Long polling to the Telegram API. Receives messages, sends replies. Splits long messages into chunks |
| **MessageParser** | `message-parser.js` | Parses message text: is it a command (`/status`) or a task (`&proj1 fix bug`)? Extracts project, branch, task text |
| **WorkQueue** | `work-queue.js` | Manages task queues. Each working directory has a separate FIFO queue. Guarantees: one `claude` process per directory. Persists state to disk |
| **PtyRunner** | `pty-runner.js` | Runs Claude in an interactive PTY session (via `node-pty`). Reuses sessions across tasks. Receives results via hook signal files. Monitors timeouts. Emits events: complete, error, timeout |
| **WorktreeManager** | `worktree-manager.js` | Creates and removes git worktrees. Auto-discovery via `git worktree list`. Maps `&project/branch` to a path on disk |
| **Logger** | `logger.js` | Writes operational log to `~/.claude/.cc-n-listener.log`. Rotation when exceeding 5 MB (old file → `.log.old`) |
| **TaskLogger** | `task-logger.js` | Writes task Q&A logs (questions to Claude and answers). Separate file per project/branch. Rotation at 5 MB |

---

## Message processing flow

```
Telegram message
       │
       ▼
TelegramPoller.getUpdates()
       │
       ├─ chat_id matches config? ── No ──► ignore + log warning
       │
       ▼ Yes
MessageParser.parse(text)
       │
       ├─ Starts with "/"? ──► Command
       │    ├─ /status, /queue, /cancel, /drop, /clear, /newsession
       │    ├─ /projects, /worktrees, /worktree, /rmworktree
       │    ├─ /history, /help, /menu, /start, /stop, /pty
       │    └─ Execute → reply in Telegram
       │    └─ Unknown /command → reply "Unknown command"
       │
       ├─ Starts with "&"? ──► Task (project-targeted)
       │    │
       │    ├─ "&proj1/feature/auth fix bug"
       │    │    → project = "proj1"
       │    │    → branch = "feature/auth"
       │    │    → text = "fix bug"
       │    │
       │    └─ "&proj1 fix bug"
       │         → project = "proj1"
       │         → branch = null (main)
       │         → text = "fix bug"
       │
       └─ Otherwise ──► Task (default project)
            │
            └─ "fix bug"
                 → project = "default"
                 → branch = null (main)
                 → text = "fix bug"
            │
            ▼
WorktreeManager.resolveWorkDir(project, branch)
       │
       ├─ branch = null → path from config (main worktree)
       ├─ branch found in worktrees → worktree path
       ├─ branch not found + autoCreate = true → git worktree add
       └─ branch not found + autoCreate = false → error
       │
       ▼
WorkQueue.enqueue(workDir, task)
       │
       ├─ workDir is free (active = null)
       │    → active = task
       │    → PtyRunner.run(workDir, task)
       │    → sends task to Claude PTY session
       │    → Telegram: "⏳ Running: fix bug"
       │
       └─ workDir is busy (active != null)
            → queue.push(task)
            → Telegram: "📋 Queued (position N)"
       │
       ▼ (when claude finishes)
TaskRunner emit 'complete'/'error'/'timeout'
       │
       ├─ Send result to Telegram
       └─ WorkQueue.onTaskComplete(workDir)
            ├─ Queue is empty → active = null
            └─ More tasks → shift() → PtyRunner.run()
```

---

## Configuration

### Interactive setup

```bash
claude-notify listener setup
```

Prompts for each listener setting interactively. Current values are shown in `[brackets]` — press Enter to keep them:

- **Worktree base dir** — where auto-created worktrees are stored
- **Task timeout, minutes** — max execution time per task
- **Max queue per work dir** — queue limit per working directory
- **Max total tasks** — global task limit across all queues
- **Log dir** — listener operational log directory
- **Task log dir** — task Q&A log directory
- **Default project path** — path for the `default` project alias

Re-run `claude-notify listener setup` anytime to reconfigure.

### Manual configuration

Full example of `~/.claude/claude-notify.config.json` with the listener section:

```json
{
  "telegram": {
    "token": "123456789:ABCdefGHIjklMNO...",
    "chatId": "987654321",
    "enabled": true,
    "deleteAfterHours": 24
  },
  "listener": {
    "claudeArgs": ["--permission-mode", "auto"],
    "continueSession": true,
    "projects": {
      "default": {
        "path": "/home/user/main-project"
      },
      "api": {
        "path": "/home/user/projects/api-server",
        "claudeArgs": ["--permission-mode", "bypassPermissions", "--model", "opus"],
        "worktrees": {
          "feature/auth": "/home/user/projects/api-wt-auth"
        }
      },
      "web": {
        "path": "/home/user/projects/web-app"
      }
    },
    "worktreeBaseDir": "~/.claude/worktrees",
    "autoCreateWorktree": true,
    "taskTimeoutMinutes": 30,
    "maxQueuePerWorkDir": 10,
    "maxTotalTasks": 50,
    "logDir": "~/.claude",
    "taskLogDir": "~/.claude"
  }
}
```

### Parameters

| Parameter | Default | Description |
|---|---|---|
| `projects` | — (required) | Map of projects: `alias → { path, worktrees?, claudeArgs? }` |
| `claudeArgs` | `[]` | Extra CLI args passed to Claude (e.g. `["--permission-mode", "auto"]`). Can also be set per-project to override |
| `continueSession` | `true` | Continue previous session context per workDir. Claude remembers previous tasks. Use `/newsession` or `/clear` to reset |
| `worktreeBaseDir` | `~/.claude/worktrees` | Where auto-created worktrees are stored |
| `autoCreateWorktree` | `true` | Automatically create a worktree if the branch is not found |
| `taskTimeoutMinutes` | `30` | Maximum task execution time in minutes. Force-stopped when exceeded |
| `maxQueuePerWorkDir` | `10` | Maximum tasks in the queue for a single working directory |
| `maxTotalTasks` | `50` | Maximum tasks across all queues combined |
| `logDir` | `~/.claude` | Directory for the listener operational log (`.cc-n-listener.log`) |
| `taskLogDir` | same as `logDir` | Directory for task Q&A logs (`.cc-n-task-*.log`). Each project/branch gets its own file |

### What is `projects`?

Each project is an alias (short name) + path to a directory on disk:

```json
{
  "api": {
    "path": "/home/user/projects/api-server"
  }
}
```

Now in Telegram you can write `&api refactor the code`, and Claude will run in the `/home/user/projects/api-server` directory.

The **`default`** alias is special. Messages without `&project` prefix go to it:

```json
{
  "default": {
    "path": "/home/user/main-project"
  }
}
```

---

## Sending tasks

### Message format

In the Telegram chat with the bot:

```
&project task                      ← task in the main worktree of the project
&project/branch task               ← task in the worktree of a specific branch
task without &project prefix       ← task in the "default" project
```

### Examples

```
add a README to the project
```
→ runs in the `default` project (if configured)

```
&api fix the authentication bug
```
→ runs in `/home/user/projects/api-server`

```
&api/feature/payments add Stripe integration
```
→ runs in the `feature/payments` worktree of the `api` project.
If the worktree doesn't exist, it will be created automatically.

```
&web update dependencies
```
→ runs in `/home/user/projects/web-app`

### What happens when a task is sent

1. The Listener receives the message from Telegram
2. Parses `&project/branch` from the beginning of the message
3. Determines the working directory (workDir)
4. Checks: is this workDir busy with another task?
   - **No** → sends task to the PTY session immediately, replies with `⏳ Running...`
   - **Yes** → adds to the queue, replies with `📋 Queued (position N)...`
5. When Claude finishes (hook signal file received) → sends the result to Telegram
6. If there's a next task in the queue → starts it

---

## Projects and worktrees

### Why worktrees?

Git worktrees allow you to have multiple working copies of the same repository in different directories, each on its own branch.

Without worktrees: one repository = one directory = one task at a time.

With worktrees: one repository, but 3 directories on different branches = 3 tasks in parallel.

```
api-server/                        ← main worktree, branch main
  └─ src/...

~/.claude/worktrees/api/
  ├─ feature-auth/                 ← worktree, branch feature/auth
  │    └─ src/...
  └─ feature-payments/             ← worktree, branch feature/payments
       └─ src/...
```

### How the listener works with worktrees

**The queue is tied to the working directory, not to the project name.**

This means:
- `&api task` and `&api/feature/auth task` are **different queues**, because they're different directories. They run **in parallel**.
- `&api task1` and `&api task2` are **the same queue** (both go to the main worktree). `task2` will wait for `task1` to complete.

```
Project "api"
  │
  ├─ main worktree (/home/user/projects/api)
  │    Queue: [task1] → [task2] → ...    ← strictly sequential
  │
  ├─ feature/auth (~/.claude/worktrees/api/feature-auth)
  │    Queue: [task3] → [task4] → ...    ← strictly sequential
  │
  └─ feature/payments (~/.claude/worktrees/api/feature-payments)
       Queue: [task5] → ...              ← strictly sequential

All three queues run IN PARALLEL.
Within each — strictly one task at a time.
```

### Auto-creation of worktrees

When you write `&api/feature/new task`, and a worktree for the `feature/new` branch doesn't exist:

1. The Listener checks: does the `feature/new` branch exist in git?
   - Yes → `git worktree add ~/.claude/worktrees/api/feature-new feature/new`
   - No → `git worktree add -b feature/new ~/.claude/worktrees/api/feature-new`
2. Registers the new worktree in the config
3. Replies in Telegram: `🌿 Created worktree feature/new for project "api"`
4. Starts the task in the new worktree

This behavior is controlled by the `autoCreateWorktree` parameter (default: `true`).

### Auto-discovery of worktrees

On startup, the listener scans each project with `git worktree list` and picks up all worktrees that were created manually (via `git worktree add`). You don't need to manually specify each worktree in the config.

### Manual worktree management from Telegram

```
/worktree &api/feature/payments     ← create a worktree
/worktrees &api                     ← list all worktrees for a project
/rmworktree &api/feature/payments   ← remove a worktree
```

---

## Task queues

### How it works

Each working directory (workDir) has:
- **active** — the task currently being executed (or `null`)
- **queue** — an array of tasks waiting to be executed (FIFO)

While `active !== null`, all new tasks for this workDir go into the `queue`.

### Example: 4 tasks, 2 projects

```
10:00  You: &api fix the router bug
       Bot: ⏳ [&api] Running: fix the router bug
       (api/main: active = "fix the router bug", queue = [])

10:01  You: &web update dependencies
       Bot: ⏳ [&web] Running: update dependencies
       (web/main: active = "update dependencies", queue = [])
       (api and web are running in parallel!)

10:02  You: &api add tests
       Bot: 📋 [&api] Queued (position 1).
            Currently running: fix the router bug
       (api/main: active = "fix the router bug", queue = ["add tests"])

10:03  You: &api refactor the code
       Bot: 📋 [&api] Queued (position 2).
            Currently running: fix the router bug
       (api/main: active = "fix the router bug", queue = ["add tests", "refactor"])

10:05  Bot: ✅ [&web] Done: update dependencies
            <result>
       (web/main: active = null, queue = [])

10:08  Bot: ✅ [&api] Done: fix the router bug
            <result>
       Bot: ⏳ [&api] Running: add tests
       (api/main: active = "add tests", queue = ["refactor"])
       (next task started automatically!)

10:15  Bot: ✅ [&api] Done: add tests
            <result>
       Bot: ⏳ [&api] Running: refactor the code
       (api/main: active = "refactor", queue = [])

10:25  Bot: ✅ [&api] Done: refactor the code
            <result>
       (api/main: active = null, queue = [])
       (all tasks completed)
```

### Limits

- Maximum **10** tasks in the queue per workDir (configurable: `maxQueuePerWorkDir`)
- Maximum **50** tasks across all queues combined (configurable: `maxTotalTasks`)
- If the limit is exceeded, the bot will reply with an error

### Timeout

If a task runs longer than 30 minutes (configurable: `taskTimeoutMinutes`), it is forcefully stopped:

```
Bot: ⏰ [&api] Task forcefully stopped — timeout exceeded (30 min): refactor the code
```

After a timeout, the next task from the queue starts automatically.

---

## Bot commands

All commands start with `/` and execute instantly (they are not queued).
Projects are referenced with the `&` prefix (e.g. `&api`, `&api/branch`).

### /status — project status

```
You: /status
Bot: 📊 Status:
     Uptime: 2h 15m

     api:
       main: ▶ fix the router bug (3m 42s) +2 queued
       feature/auth: ✅ idle
     web:
       main: ✅ idle
```

```
You: /status &api
Bot: 📊 Project "api":

     main:
       ▶ fix the router bug (3m 42s)
       Queue: 2 tasks
     feature/auth:
       ✅ idle
       Queue: 0 tasks
```

### /queue — queue contents

```
You: /queue
Bot: 📋 Queues:

     &api:
       ▶ fix the router bug
       1. add tests
       2. refactor the code
```

### /cancel — stop a running task

```
You: /cancel &api
Bot: 🛑 [&api] Task cancelled. Starting next.
     ⏳ [&api] Running: add tests
```

Cancelling a task in a worktree:

```
You: /cancel &api/feature/auth
Bot: 🛑 [&api/feature/auth] Task cancelled
```

### /drop — remove from queue

Removes a task that **hasn't started executing yet** (waiting in the queue):

```
You: /drop &api 2
Bot: 🗑 Removed from queue: refactor the code
```

The task number is the position in the queue (starting from 1). You can check numbers with `/queue`.

### /clear — clear the queue and reset session

Removes all tasks from the queue (the active task continues running) and resets the session context.
The next task will start a fresh Claude session:

```
You: /clear &api
Bot: 🧹 [&api] Queue cleared (3 tasks), session reset
```

### /newsession — reset session context

Resets the session without touching the queue. The next task starts a fresh session:

```
You: /newsession &api
Bot: 🆕 [&api] Session reset (was #5 tasks, ctx 42%). Next task starts fresh.
```

Use this when the context window is getting full or when you want Claude to "forget" previous work and start clean.

### /projects — list projects

```
You: /projects
Bot: 📂 Projects:

     @default → /home/user/main-project
     &api → /home/user/projects/api-server
       /feature/auth → ~/.claude/worktrees/api/feature-auth
     &web → /home/user/projects/web-app
```

### /worktrees — project worktrees

```
You: /worktrees &api
Bot: 🌳 Worktrees for project "api":
     • main → /home/user/projects/api-server
     • feature/auth → ~/.claude/worktrees/api/feature-auth
     • feature/payments → ~/.claude/worktrees/api/feature-payments
```

### /worktree — create a worktree

```
You: /worktree &api/feature/payments
Bot: 🌿 Created worktree for project "api":
     Branch: feature/payments
     Path: ~/.claude/worktrees/api/feature-payments
```

### /rmworktree — remove a worktree

```
You: /rmworktree &api/feature/payments
Bot: 🗑 Worktree feature/payments removed from project "api"
```

If a task is running in the worktree, removal will be rejected:

```
Bot: ❌ Cannot remove worktree: a task is running in it.
     First /cancel &api/feature/payments
```

### /history — history

```
You: /history
Bot: 📜 Recent tasks:

     ✅ [&api] fix the router bug
     ✅ [&web] update dependencies
     🛑 [&api/feature/auth] implement OAuth2
     ✅ [&api] add tests
```

### /stop — stop the listener

```
You: /stop
Bot: 👋 Listener is shutting down...
```

All active tasks will be terminated. Queues are saved to disk and will be restored on the next startup.

### /pty — PTY diagnostics

Shows real-time information about PTY sessions: state, buffer size, live console status, and the last 15 lines of cleaned output.

```
You: /pty
Bot: 🖥 PTY Sessions:

     &api
     State: busy
     Buffer: 12480 bytes
     Elapsed: 2m 35s
     Live console: ✅
     PTY log: writing

     ◐ Reading src/auth.js
     ● Editing src/middleware.js
       Added JWT validation...
```

```
You: /pty &api
Bot: (same, but for a specific project)
```

### /help — help

Shows a brief reference for all commands.

---

## Live console and PTY diagnostics

### Live console

When **`liveConsole`** is enabled (default: `true`), the "⏳ Running..." message in Telegram is periodically updated with the cleaned tail of Claude Code's PTY output, so you can see what Claude is doing in real-time.

The output is cleaned from ANSI escape codes and Claude Code UI chrome (logo, status bar, prompts), leaving only meaningful content.

Configuration:
- `liveConsole` — enable/disable (default: `true`)
- `liveConsoleInterval` — update interval in seconds (default: `5`)

### PTY logs

Each running task writes raw PTY output to a file: `{taskLogDir}/{project}_{branch}_pty.log`.
The file is overwritten when a new task starts for the same project/branch.

Monitor in real-time:
```bash
# Linux / macOS / Git Bash
tail -f ~/.claude/myproject_main_pty.log

# Windows PowerShell
Get-Content ~/.claude/myproject_main_pty.log -Wait -Tail 50
```

### /pty command

Send `/pty` or `/pty &project` in Telegram to get instant diagnostics:
- Session state (`busy` / `idle` / `starting`)
- Buffer size in bytes
- Elapsed time since task start
- Whether live console interval is active
- Whether PTY log stream is writing
- Last 15 lines of cleaned output

---

## Task lifecycle

### Path of a task from message to result

```
1. RECEIPT
   Telegram message → getUpdates() → parsing

2. ROUTING
   "&api/feature/auth task"
     → project = "api"
     → branch = "feature/auth"
     → workDir = ~/.claude/worktrees/api/feature-auth

3. QUEUING
   workDir busy?
     → No: active = task, start immediately
     → Yes: queue.push(task), reply with position

4. EXECUTION
   Task sent to Claude PTY session
     cwd = workDir
     timeout = 30 min
   Telegram: "⏳ Running: <task>"

5. WAITING
   Claude is working in the PTY session...
   (listener continues accepting other messages)
   Hook "Stop" fires → signal file written

6. COMPLETION
   Signal file received:
     lastAssistantMessage → "✅ Done" + response text
     PTY error/crash → "❌ Error"
     timeout → "⏰ Timeout"

7. NEXT TASK
   queue not empty?
     → Yes: shift() → goto 4
     → No: active = null, workDir is free
```

### How Claude runs

The listener spawns an interactive Claude Code session in a pseudo-terminal (PTY) using `node-pty`. This is equivalent to running `claude` in a real terminal — Claude has full access to all its capabilities (hooks, tools, interactive features).

The working directory (`cwd`) = project/worktree workDir.

Extra CLI arguments can be configured via `claudeArgs` in config (global or per-project).
Recommended: `["--permission-mode", "auto"]` — allows Claude to use tools (Edit, Bash, Read, etc.) without interactive prompts.

Claude sees the project files, CLAUDE.md, .claude/settings.json, and everything else as if you had launched it manually in that directory.

Task results are received via Claude's `Stop` hook, which writes a signal file containing `last_assistant_message` — the clean final response (not the raw PTY output with spinners and tool calls).

### Session continuity

When `continueSession` is enabled (default), the listener reuses the same PTY session for subsequent tasks in the same workDir. The Claude process stays alive between tasks, preserving full context — exactly like working in an interactive terminal.

Messages show session status:
- `🆕` = new session (first task or after `/newsession`/`/clear`)
- `🔄 #3` = continuing session, task number 3
- `ctx 42%` = context window usage (42% filled)

The completion message includes metadata: duration, turns, context usage, cost.

Use `/newsession` to reset the session when context gets full, or `/clear` to reset both queue and session.

### What is returned to Telegram

The `last_assistant_message` from Claude's Stop hook — the clean final response to your task.

Handling long responses:
- Up to 4096 characters — a single message
- 4096–20000 characters — multiple messages (split by lines)
- Over 20000 — first 2000 and last 2000 characters + full text as a file

---

## Logs

The listener writes two types of logs:

### Listener log (operational)

Internal events: startup, incoming messages, task lifecycle, errors.
**Does NOT contain** Claude's questions and answers.

Default path: `~/.claude/.cc-n-listener.log`
Customizable via `listener.logDir` in config.
Rotation: 5 MB (old file → `.log.old`).

### Task logs (Q&A with Claude)

Each project/branch gets its own log file with full questions sent to Claude and answers received.

Default directory: same as `listener.logDir` (i.e. `~/.claude/`)
Customizable via `listener.taskLogDir` in config.
Filename pattern: `.cc-n-task-<project>[_<branch>].log`
Rotation: 5 MB per file (old file → `.log.old`).

Each entry includes a timestamp, working directory, task text (question), and Claude's full response (answer).

Example config to customize both log directories:

```json
{
  "listener": {
    "logDir": "/var/log/claude-listener",
    "taskLogDir": "/var/log/claude-listener/tasks",
    "projects": { ... }
  }
}
```

---

## State files

All files are stored in `~/.claude/`:

| File | Description |
|---|---|
| `.listener.pid` | PID of the running daemon. On `start`, it checks whether the process is alive |
| `.cc-n-listener.log` | Operational log. Rotation when exceeding 5 MB (old file → `.log.old`) |
| `.cc-n-task-*.log` | Task Q&A logs, one per project/branch. Rotation at 5 MB each |
| `.task_queues.json` | Current state of all queues. Persisted to disk after every change |
| `.task_history.json` | Last 50 completed tasks (for `/history`) |

### Recovery after reboot

On startup, the listener:

1. Loads `.task_queues.json`
2. Watchdog checks all `active` tasks:
   - Process PID is dead → clears active, starts the next one from the queue
   - Task exceeded timeout → clears active, starts the next one
3. Tasks waiting in the queue remain and will be executed

This means: if the computer reboots, tasks in the queue won't be lost. But an active task that didn't finish will be marked as stale and skipped.

---

## Security

### Authorization

The Listener processes **only** messages from the `chatId` specified in the config. All other messages are ignored and logged as warnings.

### No shell injection

Task text is written to the PTY session's stdin, not passed through a shell command:

```js
// PTY session — text goes to Claude's interactive prompt:
ptyProcess.write(taskText + '\r')

// NOT through shell interpolation:
exec(`claude -p "${userText}"`)
```

### Isolation

- One claude process per working directory
- Strictly one task at a time in a single directory
- Different directories run in parallel but don't interfere with each other

### Limits

- 10 tasks in the queue per workDir (spam protection)
- 50 tasks total (overload protection)
- 30-minute timeout per task (hang protection)

---

## Troubleshooting

### Listener won't start

```bash
claude-notify listener status
# → Status: not running
```

Check:

1. Does the config exist? `cat ~/.claude/claude-notify.config.json`
2. Are `telegram.token` and `telegram.chatId` present?
3. Is there a `listener.projects` section?
4. Logs: `claude-notify listener logs`

### Bot doesn't respond

1. Is the listener running? `claude-notify listener status`
2. Is the chatId correct? Messages from other chats are ignored (check the log: `WARN Ignored message from chat ...`)
3. Is the bot added to the chat? Write `/help` to the bot — if there's no response, check the token

### Task is stuck

```
/cancel &project
```

Or restart the listener:

```bash
claude-notify listener restart
```

The watchdog will automatically clear stale tasks on the next startup.

### Claude gives low-quality responses (doesn't edit files, just describes what to do)

Add `claudeArgs` to your listener config to grant tool permissions:

```json
"listener": {
  "claudeArgs": ["--permission-mode", "auto"]
}
```

Available permission modes:
- `auto` — allows tools with smart auto-approval (recommended)
- `bypassPermissions` — allows everything without any checks (use in trusted environments)

Other useful flags:
- `--model opus` — force a specific model
- `--allowedTools "Bash Edit Read Write"` — allow specific tools only

Restart the listener after changing config: `claude-notify listener restart`

### Context window getting full

After many tasks in the same session, the context window fills up and responses may degrade.
The completion message shows `ctx N%` — when it's above ~80%, consider resetting:

```
/newsession &project
```

This starts a fresh session without clearing the task queue. You can also use `/clear` to reset both.

### Claude can't find project files

Check the path in the config:

```
/projects
```

Make sure the path exists and contains the correct repository.

---

## Full session example

Suppose you have two projects: an API server and a web application.

### Configuration

```json
{
  "telegram": {
    "token": "123456789:ABCdef...",
    "chatId": "987654321"
  },
  "listener": {
    "claudeArgs": ["--permission-mode", "auto"],
    "continueSession": true,
    "projects": {
      "api": { "path": "/home/user/projects/api" },
      "web": { "path": "/home/user/projects/web" }
    }
  }
}
```

### Telegram session

```
=== 10:00 — Startup ===

You (terminal): claude-notify listener start
              → Listener started (PID: 12345)

=== 10:01 — First task ===

You: &api add endpoint GET /users with pagination
Bot: ⏳ [&api] Running: add endpoint GET /users with pagination

    Behind the scenes: PTY session created
    claude (interactive PTY) → task sent
    cwd = /home/user/projects/api

=== 10:02 — Task to another project (in parallel!) ===

You: &web add a /users page that calls GET /users
Bot: ⏳ [&web] Running: add a /users page that calls GET /users

    Now two PTY sessions are running in parallel:
    one in /home/user/projects/api, another in /home/user/projects/web

=== 10:03 — Another task for api (queued) ===

You: &api add tests for /users
Bot: 📋 [&api] Queued (position 1).
     Currently running: add endpoint GET /users with pagination

=== 10:04 — Task in a worktree (in parallel with api/main!) ===

You: &api/feature/auth add JWT authorization middleware
Bot: 🌿 Created worktree feature/auth for project "api"
     ⏳ [&api/feature/auth] Running: add JWT authorization middleware

    Three PTY sessions running in parallel:
    1. api/main     → GET /users
    2. api/auth     → JWT middleware
    3. web/main     → /users page

=== 10:05 — Check status ===

You: /status
Bot: 📊 Status:
     Uptime: 5m 12s

     api:
       main: ▶ add endpoint GET /users with pagination (4m 30s) +1 queued
       feature/auth: ▶ add JWT authorization middleware (1m 05s)
     web:
       main: ▶ add a /users page... (3m 20s)

=== 10:07 — web finished ===

Bot: ✅ [&web] Done: add a /users page that calls GET /users

     Created file src/pages/Users.vue with a user table.
     Added route in src/router.js.
     Uses fetch to /api/users with page and limit parameters.

=== 10:09 — api/main finished, automatically starts the next task ===

Bot: ✅ [&api] Done: add endpoint GET /users with pagination

     Created controller src/controllers/users.js.
     Added route GET /users in src/routes.js.
     Supports query parameters: page, limit, sort.

Bot: ⏳ [&api] Running: add tests for /users

    Next task from the queue started automatically!

=== 10:12 — Cancel a worktree task ===

You: /cancel &api/feature/auth
Bot: 🛑 [&api/feature/auth] Task cancelled

=== 10:15 — api/main (tests) finished ===

Bot: ✅ [&api] Done: add tests for /users

     Created tests/users.test.js.
     Covered cases: pagination, sorting, empty result, errors.

=== 10:16 — Check history ===

You: /history
Bot: 📜 Recent tasks:

     ✅ [&api] add tests for /users
     🛑 [&api/feature/auth] add JWT authorization middleware
     ✅ [&api] add endpoint GET /users with pagination
     ✅ [&web] add a /users page...

=== 10:17 — Remove unneeded worktree ===

You: /rmworktree &api/feature/auth
Bot: 🗑 Worktree feature/auth removed from project "api"

=== Evening — Shut down ===

You: /stop
Bot: 👋 Listener is shutting down...
```
