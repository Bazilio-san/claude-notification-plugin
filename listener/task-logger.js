#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

function sanitize (str) {
  return str.replace(/[/\\:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '');
}

function rotateIfNeeded (filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_LOG_SIZE) {
      const backup = filePath + '.old';
      if (fs.existsSync(backup)) {
        fs.unlinkSync(backup);
      }
      fs.renameSync(filePath, backup);
    }
  } catch {
    // file doesn't exist yet
  }
}

/**
 * Creates a task logger that writes Q&A logs for Claude tasks.
 * Each project/branch combo gets its own log file.
 *
 * @param {string} logDir - Directory for task log files
 */
export function createTaskLogger (logDir) {
  fs.mkdirSync(logDir, { recursive: true });

  function getLogPath (project, branch) {
    const parts = [project];
    if (branch && branch !== 'main' && branch !== 'master') {
      parts.push(branch);
    }
    const name = `.cc-n-task-${sanitize(parts.join('_'))}.log`;
    return path.join(logDir, name);
  }

  return {
    logQuestion (project, branch, workDir, taskText) {
      const logPath = getLogPath(project, branch);
      rotateIfNeeded(logPath);
      const ts = new Date().toISOString();
      const entry = `\n${'='.repeat(80)}\n`
        + `[${ts}] QUESTION\n`
        + `Project: /${project}${branch && branch !== 'main' && branch !== 'master' ? '/' + branch : ''}\n`
        + `WorkDir: ${workDir}\n`
        + `Task: ${taskText}\n`;
      fs.appendFileSync(logPath, entry);
    },

    logAnswer (project, branch, output, exitCode) {
      const logPath = getLogPath(project, branch);
      rotateIfNeeded(logPath);
      const ts = new Date().toISOString();
      const status = exitCode === 0 ? 'OK' : `ERROR (code ${exitCode})`;
      const entry = `[${ts}] ANSWER [${status}]\n`
        + `${output || '(no output)'}\n`;
      fs.appendFileSync(logPath, entry);
    },
  };
}
