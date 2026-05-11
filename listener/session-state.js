// Persistent map of workDir → last known Claude sessionId.
// Survives listener restarts so the next task in a workDir can be launched
// with `claude --resume <sid>` and continue exactly the session that was
// running before the restart, instead of `--continue` blindly picking the
// most-recently-modified JSONL (which may belong to a completed turn, a
// different branch, or a manually-opened terminal in the same project dir).

import fs from 'fs';
import path from 'path';
import { CLAUDE_DIR, normalizeForCompare } from '../bin/constants.js';

const SESSION_STATE_PATH = path.join(CLAUDE_DIR, '.session_state.json');

function readState () {
  try {
    const raw = fs.readFileSync(SESSION_STATE_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeState (state) {
  try {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    const tmp = `${SESSION_STATE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, SESSION_STATE_PATH);
  } catch {
    // best-effort; never throw
  }
}

function keyFor (workDir) {
  return normalizeForCompare(workDir);
}

export function getStoredSessionId (workDir) {
  if (!workDir) {
    return null;
  }
  const state = readState();
  const entry = state[keyFor(workDir)];
  return entry?.sessionId || null;
}

export function setStoredSessionId (workDir, sessionId) {
  if (!workDir || !sessionId) {
    return;
  }
  const state = readState();
  state[keyFor(workDir)] = {
    sessionId,
    updatedAt: new Date().toISOString(),
    workDir,
  };
  writeState(state);
}

export function clearStoredSessionId (workDir) {
  if (!workDir) {
    return;
  }
  const state = readState();
  const k = keyFor(workDir);
  if (k in state) {
    delete state[k];
    writeState(state);
  }
}

export { SESSION_STATE_PATH };
