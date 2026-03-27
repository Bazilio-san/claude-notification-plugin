import fs from 'fs';
import path from 'path';
import { CLAUDE_DIR } from '../bin/constants.js';

const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/**
 * Encode a cwd path into the Claude Code project directory name.
 * Replaces : \ / . _ with dashes.
 *
 * Examples:
 *   D:\DEV\FA\_pub\my-project → D--DEV-FA--pub-my-project
 *   /home/user/projects/api   → -home-user-projects-api
 */
export function cwdToProjectDir (cwd) {
  return cwd.replace(/[:\\/._]/g, '-');
}

/**
 * Find the JSONL file path for a given cwd and sessionId.
 * Returns null if the file does not exist.
 */
export function resolveJsonlPath (cwd, sessionId) {
  if (!sessionId) {
    return null;
  }
  const dirName = cwdToProjectDir(cwd);
  const filePath = path.join(PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return filePath;
  } catch {
    return null;
  }
}

/**
 * Find the most recently modified JSONL file for a given cwd.
 * Used as a fallback when sessionId is not yet known.
 * Returns null if no fresh file is found within maxAgeMs.
 */
export function resolveJsonlByMtime (cwd, maxAgeMs = 120_000) {
  const dirName = cwdToProjectDir(cwd);
  const dirPath = path.join(PROJECTS_DIR, dirName);
  let files;
  try {
    files = fs.readdirSync(dirPath);
  } catch {
    return null;
  }

  let best = null;
  let bestMtime = 0;
  const now = Date.now();

  for (const f of files) {
    if (!f.endsWith('.jsonl')) {
      continue;
    }
    try {
      const stat = fs.statSync(path.join(dirPath, f));
      if (stat.mtimeMs > bestMtime && now - stat.mtimeMs < maxAgeMs) {
        bestMtime = stat.mtimeMs;
        best = path.join(dirPath, f);
      }
    } catch {
      // ignore
    }
  }

  return best;
}

/**
 * Incremental JSONL file reader.
 * Reads new lines from a JSONL file since the last read.
 */
export class JsonlReader {
  constructor (filePath, logger) {
    this.filePath = filePath;
    this.logger = logger || null;
    this._offset = 0;
    this._remainder = '';
    this._lastAssistantText = '';
    this._lastToolUse = null;
  }

  /**
   * Read new lines since last call, parse JSON, update internal state.
   * Returns array of parsed JSONL objects (only new ones).
   */
  readNew () {
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
    } catch {
      return [];
    }

    try {
      const stat = fs.fstatSync(fd);
      if (stat.size <= this._offset) {
        return [];
      }

      const buf = Buffer.alloc(stat.size - this._offset);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, this._offset);
      if (bytesRead === 0) {
        return [];
      }
      this._offset += bytesRead;

      const chunk = this._remainder + buf.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');
      // Last element may be incomplete — save as remainder
      this._remainder = lines.pop() || '';

      const entries = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const obj = JSON.parse(trimmed);
          entries.push(obj);
          this._processEntry(obj);
        } catch {
          // skip malformed lines
        }
      }
      return entries;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Process a parsed JSONL entry to update last assistant content.
   */
  _processEntry (entry) {
    if (entry.message?.role !== 'assistant') {
      return;
    }

    const content = entry.message?.content;
    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (block.type === 'text' && block.text) {
        this._lastAssistantText = block.text;
        this._lastToolUse = null; // text supersedes tool_use display
      } else if (block.type === 'tool_use') {
        this._lastToolUse = {
          name: block.name || 'unknown',
          input: block.input || {},
        };
      }
      // thinking blocks are ignored for display
    }
  }

  /**
   * Get formatted display text from the last assistant message.
   * Returns a short summary suitable for Telegram live console.
   */
  getDisplayContent (maxChars = 300) {
    const parts = [];

    if (this._lastToolUse) {
      parts.push(formatToolUse(this._lastToolUse));
    }

    if (this._lastAssistantText) {
      parts.push(this._lastAssistantText);
    }

    if (parts.length === 0) {
      return '';
    }

    let result = parts.join('\n\n');
    if (result.length > maxChars) {
      result = result.slice(-maxChars);
      // Trim to last complete line
      const nlIdx = result.indexOf('\n');
      if (nlIdx > 0) {
        result = result.slice(nlIdx + 1);
      }
    }
    return result;
  }

  /**
   * Reset reader to re-read from the beginning.
   */
  reset () {
    this._offset = 0;
    this._remainder = '';
    this._lastAssistantText = '';
    this._lastToolUse = null;
  }
}

/**
 * Format a tool_use block into a short display string.
 */
function formatToolUse (tool) {
  const name = tool.name || '';
  const input = tool.input || {};
  const trunc = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s);
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return input.file_path
        ? `🔧 ${name}: ${path.basename(input.file_path)}`
        : `🔧 ${name}`;
    case 'Bash':
      return input.command
        ? `🔧 $ ${trunc(input.command, 80)}${input.run_in_background ? ' (bg)' : ''}${input.timeout ? ` (timeout ${input.timeout})` : ''}`
        : '🔧 Bash';
    case 'Grep':
      if (input.pattern) {
        const where = typeof input.path === 'string'
          ? path.basename(input.path)
          : (typeof input.glob === 'string' ? input.glob : '');

        const flags = [];
        if (input['-n']) flags.push('-n');
        if (input['-C']) flags.push(`-C ${input['-C']}`);
        if (!input['-C'] && (typeof input.context === 'number' || typeof input.context === 'string')) {
          flags.push(`-C ${input.context}`);
        }
        if (input['-i']) flags.push('-i');
        if (input['-A']) flags.push(`-A ${input['-A']}`);
        if (input['-B']) flags.push(`-B ${input['-B']}`);
        if (input.head_limit) flags.push(`head ${input.head_limit}`);
        const flagStr = flags.length ? ` ${flags.join(' ')}` : '';

        return where
          ? `🔧 Grep${flagStr}: ${trunc(input.pattern, 60)} in ${trunc(where, 30)}`
          : `🔧 Grep${flagStr}: ${trunc(input.pattern, 80)}`;
      }
      return '🔧 Grep';
    case 'Glob':
      if (input.pattern) {
        const p = typeof input.path === 'string' ? path.basename(input.path) : '';
        return p ? `🔧 Glob: ${trunc(input.pattern, 60)} in ${trunc(p, 30)}` : `🔧 Glob: ${trunc(input.pattern, 80)}`;
      }
      return '🔧 Glob';
    case 'Agent':
      if (input.description) {
        const bg = input.run_in_background ? ' (bg)' : '';
        const st = typeof input.subagent_type === 'string' && input.subagent_type.trim()
          ? ` [${input.subagent_type.trim()}]`
          : '';
        return `🔧 Agent${bg}${st}: ${trunc(input.description, 80)}`;
      }
      return '🔧 Agent';
    case 'Skill':
      return input.skill
        ? `🔧 Skill: ${input.skill}${input.args ? ` ${trunc(String(input.args), 80)}` : ''}`
        : '🔧 Skill';
    case 'WebFetch':
      if (input.url) {
        const hasPrompt = typeof input.prompt === 'string' && input.prompt.trim();
        return `🔧 Fetch${hasPrompt ? '*' : ''}: ${trunc(input.url, 80)}`;
      }
      return '🔧 WebFetch';
    case 'WebSearch':
      return input.query ? `🔧 Search: ${input.query}` : '🔧 WebSearch';
    case 'ToolSearch':
      return input.query ? `🔧 ToolSearch: ${trunc(input.query, 200)}` : '🔧 ToolSearch';
    case 'TaskCreate':
      return input.subject
        ? `🔧 Task+: ${trunc(input.subject, 100)}`
        : '🔧 TaskCreate';
    case 'TaskUpdate':
      return input.taskId && input.status
        ? `🔧 Task#${input.taskId}: ${input.status}`
        : (input.taskId ? `🔧 Task#${input.taskId}` : '🔧 TaskUpdate');
    case 'ExitPlanMode':
      return input.planFilePath
        ? `🔧 ExitPlanMode: ${path.basename(input.planFilePath)}`
        : '🔧 ExitPlanMode';
    case 'Task':
      if (input.description) {
        const st = typeof input.subagent_type === 'string' && input.subagent_type.trim()
          ? ` [${input.subagent_type.trim()}]`
          : '';
        return `🔧 Task${st}: ${trunc(input.description, 80)}`;
      }
      return '🔧 Task';
    case 'TaskOutput':
      if (input.task_id) {
        return `🔧 Task#${input.task_id}: output${input.timeout ? ` (timeout ${input.timeout})` : ''}`;
      }
      return '🔧 TaskOutput';
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? input.questions : [];
      if (qs.length > 0) {
        const first = qs[0] || {};
        const head = (typeof first.header === 'string' && first.header.trim())
          ? first.header.trim()
          : (typeof first.question === 'string' ? first.question.trim() : '');
        const suffix = qs.length > 1 ? ` (+${qs.length - 1})` : '';
        if (head) {
          return `🔧 Ask: ${trunc(head, 120)}${suffix}`;
        }
        return `🔧 AskUserQuestion${suffix}`;
      }
      return '🔧 AskUserQuestion';
    }
    default:
      if (name.startsWith('mcp__playwright__browser_')) {
        const action = name.slice('mcp__playwright__browser_'.length);
        switch (action) {
          case 'navigate':
            return input.url ? `🔧 PW nav: ${trunc(input.url, 80)}` : '🔧 PW nav';
          case 'click': {
            const ref = typeof input.ref === 'string' ? input.ref : '';
            const el = typeof input.element === 'string' ? input.element : '';
            return `🔧 PW click: ${trunc(ref || el || '', 80)}`.trim();
          }
          case 'type': {
            const ref = typeof input.ref === 'string' ? input.ref : '';
            const text = typeof input.text === 'string' ? input.text : '';
            return `🔧 PW type: ${trunc(ref || '', 40)}${text ? ` (${text.length} chars)` : ''}`.trim();
          }
          case 'take_screenshot':
            return input.filename ? `🔧 PW shot: ${trunc(input.filename, 80)}` : '🔧 PW shot';
          case 'wait_for':
            return input.time ? `🔧 PW wait: ${input.time}` : '🔧 PW wait';
          case 'console_messages':
            return input.level ? `🔧 PW console: ${input.level}` : '🔧 PW console';
          case 'snapshot':
            return '🔧 PW snapshot';
          default:
            return `🔧 PW: ${action}`;
        }
      }
      if (name === 'mcp__sequential-thinking__sequentialthinking') {
        const n = input.thoughtNumber;
        const total = input.totalThoughts;
        const head = (typeof n === 'number' || typeof n === 'string') && (typeof total === 'number' || typeof total === 'string')
          ? `${n}/${total} `
          : '';
        const thought = typeof input.thought === 'string' ? trunc(input.thought.trim(), 80) : '';
        return `🔧 Think: ${head}${thought}`.trim();
      }
      if (name === 'mcp__serena__list_dir') {
        return input.relative_path ? `🔧 Serena ls: ${trunc(input.relative_path, 80)}` : '🔧 Serena ls';
      }
      if (name === 'mcp__serena__get_symbols_overview') {
        return input.relative_path ? `🔧 Serena symbols: ${trunc(input.relative_path, 80)}` : '🔧 Serena symbols';
      }
      if (name.startsWith('mcp__')) {
        if (name === 'mcp__context7__resolve-library-id') {
          return input.libraryName
            ? `🔧 C7 lib: ${trunc(input.libraryName, 60)}`
            : '🔧 C7 resolve';
        }
        if (name === 'mcp__context7__query-docs') {
          const lib = typeof input.libraryId === 'string' ? input.libraryId : '';
          const q = typeof input.query === 'string' ? input.query : '';
          return `🔧 C7 docs: ${trunc(q || lib || '', 80)}`.trim();
        }
        const parts = name.split('__');
        return parts.length >= 3 ? `🔧 MCP ${parts[1]}: ${parts[2]}` : `🔧 ${name}`;
      }
      return `🔧 ${name}`;
  }
}
