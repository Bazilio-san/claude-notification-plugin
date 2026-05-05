import fs from 'fs';
import path from 'path';
import { CLAUDE_DIR } from '../bin/constants.js';
import { cwdToProjectDir } from './jsonl-reader.js';
import { findLocking } from './file-locks.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

const PREVIEW_MAX_LINES = 200;
const PREVIEW_MAX_CHARS = 120;

/**
 * List the most recent Claude Code sessions (JSONL files) for a workDir,
 * with status and a short preview of the first user message.
 *
 * Status semantics:
 *   - working:  file is locked AND mtime within workingThresholdSec
 *   - idle:     file is locked AND older than workingThresholdSec
 *   - free:     file is not locked
 *
 * @param {string}   workDir              cwd whose project dir to scan
 * @param {object}   opts
 * @param {number}   opts.limit                  max sessions to return
 * @param {number}   opts.workingThresholdSec    mtime ≤ this AND locked → working
 * @param {object}   opts.logger
 * @returns {Promise<Array<{sessionId, filePath, mtime, size, status, lockedBy, preview}>>}
 */
export async function listSessions (workDir, { limit = 5, workingThresholdSec = 2, logger } = {}) {
  const dirName = cwdToProjectDir(workDir);
  const dirPath = path.join(PROJECTS_DIR, dirName);

  let entries;
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  const candidates = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) {
      continue;
    }
    const filePath = path.join(dirPath, name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) {
      continue;
    }
    candidates.push({
      sessionId: name.slice(0, -'.jsonl'.length),
      filePath,
      mtime: stat.mtimeMs,
      size: stat.size,
    });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const top = candidates.slice(0, limit);

  if (top.length === 0) {
    return [];
  }

  const lockMap = await findLocking(top.map(s => s.filePath), logger);
  const now = Date.now();
  const workingMs = workingThresholdSec * 1000;

  for (const s of top) {
    const pids = lockMap.get(s.filePath) || [];
    s.lockedBy = pids;
    if (pids.length > 0) {
      s.status = (now - s.mtime) <= workingMs ? 'working' : 'idle';
    } else {
      s.status = 'free';
    }
    s.preview = readFirstUserMessage(s.filePath);
  }

  return top;
}

/**
 * Read the first user-typed message text from a JSONL session file.
 * Returns a short single-line preview, or an empty string if not found.
 */
function readFirstUserMessage (filePath) {
  let buf;
  try {
    // Read up to 256 KB — first user message is almost always very early.
    const fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, chunk, 0, chunk.length, 0);
    fs.closeSync(fd);
    buf = chunk.slice(0, n).toString('utf-8');
  } catch {
    return '';
  }

  const lines = buf.split('\n');
  const max = Math.min(lines.length, PREVIEW_MAX_LINES);
  for (let i = 0; i < max; i++) {
    const line = lines[i];
    if (!line || line[0] !== '{') {
      continue;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type !== 'user' || !rec.message) {
      continue;
    }
    const content = rec.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          text = part.text;
          break;
        }
      }
    }
    if (!text) {
      continue;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > PREVIEW_MAX_CHARS) {
      text = text.slice(0, PREVIEW_MAX_CHARS - 1) + '…';
    }
    return text;
  }
  return '';
}
