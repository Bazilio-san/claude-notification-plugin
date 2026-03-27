# How To: Scan JSONL For New Tool Patterns (And Update `formatToolUse`)

This repo includes a scanner script:

- `scripts/scan-claude-jsonl-patterns.js`

It walks all project folders under Claude Code logs, reads every `*.jsonl`, and writes a log with only *new* patterns since the last run (based on a cache file).

## One Command To Run

```powershell
node D:\DEV\FA\_pub\claude-notification-plugin\scripts\scan-claude-jsonl-patterns.js
```

Outputs (default):
- Cache: `D:\DEV\FA\_pub\claude-notification-plugin\_cache\claude-jsonl-patterns.json`
- Log: `D:\DEV\FA\_pub\claude-notification-plugin\_logs\claude-jsonl-patterns-new.jsonl`

## Prompt To Ask Codex (Copy/Paste)

Use this prompt after the scan finishes:

```text
Run the JSONL pattern scanner and then update the project based on the produced log.

1) Run:
   node D:\DEV\FA\_pub\claude-notification-plugin\scripts\scan-claude-jsonl-patterns.js

2) Open and analyze:
   D:\DEV\FA\_pub\claude-notification-plugin\_logs\claude-jsonl-patterns-new.jsonl

3) If the log contains any new tool names or new input keys that are useful for display,
   extend listener/jsonl-reader.js -> formatToolUse() accordingly.

Rules:
- Keep output short and consistent with existing tool summaries.
- Never print secrets from examples; keep any redaction behavior.
- After editing, run a quick Node import check for listener/jsonl-reader.js.

Finally:
- Summarize what new patterns were found (tool + keys),
- List what was added/changed in formatToolUse.
```

## Notes / Options

- If you expect a lot of new patterns, increase log limit:

```powershell
node D:\DEV\FA\_pub\claude-notification-plugin\scripts\scan-claude-jsonl-patterns.js --maxLogEvents 20000
```

- To do a clean rescan from scratch, delete the cache file:
  `D:\DEV\FA\_pub\claude-notification-plugin\_cache\claude-jsonl-patterns.json`

