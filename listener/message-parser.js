#!/usr/bin/env node

/**
 * Parse a Telegram message into a command or task.
 *
 * Formats:
 *   /command args           → { type: 'command', cmd, args }
 *   &project/branch text    → { type: 'task', project, branch, text }
 *   &project text           → { type: 'task', project, branch: null, text }
 *   text                    → { type: 'task', project: <defaultProject>, branch: null, text }
 *
 * Raw slash-commands forwarded to the live Claude REPL:
 *   %cmd [args]             → task with raw:true, text='/cmd [args]'
 *   &project %cmd [args]    → same, targeting the project's PTY
 *   %%foo                   → literal task starting with "%foo" (escape)
 *
 * Any /word is treated as a listener command (known or unknown).
 * Project designation uses & prefix: &project or &project/branch.
 *
 * @param {string} text - The message text.
 * @param {string} [defaultProject] - Alias of the default project (used for plain text tasks).
 */
export function parseMessage (text, defaultProject) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  // Commands: anything starting with /
  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname
    return {
      type: 'command',
      cmd,
      args: parts.slice(1).join(' '),
    };
  }

  // Project-targeted task: &project[/branch] text
  if (trimmed.startsWith('&')) {
    const projectMatch = trimmed.match(/^&(\S+)\s+([\s\S]+)$/);
    if (projectMatch) {
      const target = projectMatch[1];
      const rawText = projectMatch[2].trim();
      const { text: taskText, raw } = parseRawPrefix(rawText);

      const slashIndex = target.indexOf('/');
      if (slashIndex > 0) {
        return {
          type: 'task',
          project: target.substring(0, slashIndex),
          branch: target.substring(slashIndex + 1),
          text: taskText,
          raw,
        };
      }
      return {
        type: 'task',
        project: target,
        branch: null,
        text: taskText,
        raw,
      };
    }
  }

  // Plain text → default project
  const { text: taskText, raw } = parseRawPrefix(trimmed);
  return {
    type: 'task',
    project: defaultProject || 'default',
    branch: null,
    text: taskText,
    raw,
  };
}

/**
 * Detect `%cmd` / `%%literal` prefix.
 * - `%%foo`  → plain task "%foo"
 * - `%foo`   → raw task "/foo" (forwarded to PTY verbatim)
 * - anything else → unchanged plain task
 */
function parseRawPrefix (text) {
  if (text.startsWith('%%')) {
    return { text: text.slice(1), raw: false };
  }
  if (text.startsWith('%')) {
    return { text: '/' + text.slice(1), raw: true };
  }
  return { text, raw: false };
}

/**
 * Parse &project or &project/branch from command args.
 * Returns { project, branch, rest } or null.
 */
export function parseTarget (args) {
  if (!args) {
    return null;
  }
  const match = args.trim().match(/^&(\S+)/);
  if (!match) {
    return null;
  }
  const target = match[1];
  const slashIndex = target.indexOf('/');
  if (slashIndex > 0) {
    return {
      project: target.substring(0, slashIndex),
      branch: target.substring(slashIndex + 1),
      rest: args.trim().substring(match[0].length).trim(),
    };
  }
  return {
    project: target,
    branch: null,
    rest: args.trim().substring(match[0].length).trim(),
  };
}
