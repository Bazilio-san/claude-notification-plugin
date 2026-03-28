#!/usr/bin/env node
/**
 * Scan Claude Code JSONL logs under a root folder for new tool_use patterns.
 *
 * What it detects:
 * - New tool name (block.type === "tool_use", block.name)
 * - New input keys for an existing tool name (block.input.*)
 *
 * Outputs:
 * - Log (JSONL) with only NEW discoveries since last run
 * - Cache (JSON) of known tools + input keys
 *
 * Default locations are in repo folders ignored by .gitignore:
 * - Cache: <repo>/_cache/claude-jsonl-patterns.json
 * - Log:   <repo>/_logs/claude-jsonl-patterns-new.jsonl
 *
 * Usage:
 *   node scripts/scan-claude-jsonl-patterns.js
 *   node scripts/scan-claude-jsonl-patterns.js --root "C:\\Users\\vv\\.claude\\projects"
 *   node scripts/scan-claude-jsonl-patterns.js --log "_logs\\scan-2026-03-27.jsonl"
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function parseArgs (argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      continue;
    }
    const k = a.slice(2);
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) {
      out[k] = true;
    } else {
      out[k] = v;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv);

const DEFAULT_ROOT = 'C:\\Users\\vv\\.claude\\projects';
const rootDir = args.root || DEFAULT_ROOT;

const cachePath = path.resolve(repoRoot, args.cache || path.join('_cache', 'claude-jsonl-patterns.json'));
const logPath = path.resolve(repoRoot, args.log || path.join('_logs', 'claude-jsonl-patterns-new.jsonl'));

const MAX_LOG_EVENTS = Number.isFinite(Number(args.maxLogEvents)) ? Number(args.maxLogEvents) : 5000;
const MAX_STRING = Number.isFinite(Number(args.maxString)) ? Number(args.maxString) : 200;

function ensureDir (p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function safeReadJson (p, fallback) {
  try {
    if (!fs.existsSync(p)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson (p, obj) {
  ensureDir(p);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function writeJsonlLine (fd, obj) {
  fs.writeSync(fd, `${JSON.stringify(obj)}\n`, null, 'utf8');
}

function truncStr (s, n) {
  if (typeof s !== 'string') {
    return s;
  }
  if (s.length <= n) {
    return s;
  }
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function sanitizeString (s) {
  if (typeof s !== 'string') {
    return s;
  }

  // Telegram bot token in URL: /bot123456:ABC.../
  s = s.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>');

  // Bearer tokens
  s = s.replace(/Bearer\s+[A-Za-z0-9\-_.]{20,}/gi, 'Bearer <redacted>');

  // JWT-like tokens
  if (s.length > 60 && /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(s)) {
    s = '<jwt>';
  }

  return truncStr(s, MAX_STRING);
}

function sanitizeValue (v, keyHint = '') {
  const k = String(keyHint || '');
  const isSecretKey = /(token|password|secret|authorization|cookie|session|apikey|api_key)/i.test(k);
  if (isSecretKey) {
    return '<redacted>';
  }

  if (v == null) {
    return v;
  }
  if (typeof v === 'string') {
    return sanitizeString(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }

  if (Array.isArray(v)) {
    return v.slice(0, 20).map((x) => sanitizeValue(x, keyHint));
  }

  if (typeof v === 'object') {
    const out = {};
    for (const [kk, vv] of Object.entries(v)) {
      out[kk] = sanitizeValue(vv, kk);
    }
    return out;
  }

  return '<unserializable>';
}

function listDirs (p) {
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(d => d.isDirectory()).map(d => path.join(p, d.name));
}

function listJsonlFiles (dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.jsonl'))
    .map(e => path.join(dir, e.name))
    .sort((a, b) => a.localeCompare(b));
}

const cache = safeReadJson(cachePath, {
  version: 1,
  updatedAt: null,
  tools: {}, // toolName -> { keys: { key: { firstSeenAt, example: {...} } } }
});

let logCount = 0;
let logLimitReached = false;
ensureDir(logPath);
const logFd = fs.openSync(logPath, 'w');

writeJsonlLine(logFd, {
  type: 'scan_start',
  at: new Date().toISOString(),
  rootDir,
  cachePath,
});

function recordDiscovery (evt) {
  if (logLimitReached) {
    return false;
  }
  if (logCount >= MAX_LOG_EVENTS) {
    logLimitReached = true;
    writeJsonlLine(logFd, {
      type: 'log_limit_reached',
      at: new Date().toISOString(),
      maxLogEvents: MAX_LOG_EVENTS,
      message: 'Stopped scanning early to avoid updating cache without logging all new patterns. Rerun with a higher --maxLogEvents.',
    });
    return false;
  }
  writeJsonlLine(logFd, evt);
  logCount++;
  return true;
}

function ensureTool (toolName) {
  if (!cache.tools[toolName]) {
    cache.tools[toolName] = { keys: {} };
    return true;
  }
  return false;
}

async function scanFile (filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;

  for await (const line of rl) {
    if (logLimitReached) {
      break;
    }
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const blocks = obj?.message?.content;
    if (!Array.isArray(blocks)) {
      continue;
    }

    for (const b of blocks) {
      if (logLimitReached) {
        break;
      }
      if (!b || b.type !== 'tool_use') {
        continue;
      }
      const toolName = String(b.name || 'unknown');
      const input = (b && typeof b.input === 'object' && b.input) ? b.input : {};

      const isNewTool = ensureTool(toolName);
      if (isNewTool) {
        recordDiscovery({
          type: 'new_tool',
          at: new Date().toISOString(),
          tool: toolName,
          file: filePath,
          line: lineNo,
          exampleInput: sanitizeValue(input),
        });
      }

      // Track input keys (top-level)
      const keys = Object.keys(input || {});
      if (keys.length === 0) {
        continue;
      }

      for (const k of keys) {
        if (logLimitReached) {
          break;
        }
        if (cache.tools[toolName].keys[k]) {
          continue;
        }
        cache.tools[toolName].keys[k] = {
          firstSeenAt: new Date().toISOString(),
          example: {
            file: filePath,
            line: lineNo,
            input: sanitizeValue(input),
          },
        };
        recordDiscovery({
          type: 'new_input_key',
          at: new Date().toISOString(),
          tool: toolName,
          key: k,
          file: filePath,
          line: lineNo,
          exampleInput: sanitizeValue(input),
        });
      }
    }
  }
}

let dirCount = 0;
let fileCount = 0;
let jsonlCount = 0;

const dirs = listDirs(rootDir).sort((a, b) => a.localeCompare(b));
for (const dir of dirs) {
  if (logLimitReached) {
    break;
  }
  dirCount++;
  const jsonls = listJsonlFiles(dir);
  if (jsonls.length === 0) {
    continue;
  }

  jsonlCount += jsonls.length;
  for (const f of jsonls) {
    if (logLimitReached) {
      break;
    }
    fileCount++;
    // Progress every ~250 files to keep output calm.
    if (fileCount % 250 === 0) {
      process.stdout.write(`Scanned ${fileCount}/${jsonlCount || '?'} JSONL files...\n`);
    }
     
    await scanFile(f);
  }
}

cache.updatedAt = new Date().toISOString();
atomicWriteJson(cachePath, cache);

writeJsonlLine(logFd, {
  type: 'scan_done',
  at: new Date().toISOString(),
  scanned: { dirCount, fileCount, jsonlCount },
  newEventsWritten: logCount,
  cachePath,
  logPath,
});

fs.closeSync(logFd);

process.stdout.write(`Done.\nCache: ${cachePath}\nLog: ${logPath}\nNew events: ${logCount}\n`);
