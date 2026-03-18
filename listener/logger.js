#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

export function createLogger (logPath) {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });

  function rotateIfNeeded () {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > MAX_LOG_SIZE) {
        const backup = logPath + '.old';
        if (fs.existsSync(backup)) {
          fs.unlinkSync(backup);
        }
        fs.renameSync(logPath, backup);
      }
    } catch {
      // file doesn't exist yet
    }
  }

  function formatLine (level, msg) {
    const ts = new Date().toISOString();
    return `[${ts}] [${level}] ${msg}\n`;
  }

  return {
    info (msg) {
      rotateIfNeeded();
      fs.appendFileSync(logPath, formatLine('INFO', msg));
    },
    error (msg) {
      rotateIfNeeded();
      fs.appendFileSync(logPath, formatLine('ERROR', msg));
    },
    warn (msg) {
      rotateIfNeeded();
      fs.appendFileSync(logPath, formatLine('WARN', msg));
    },
  };
}
