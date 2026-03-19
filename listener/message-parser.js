#!/usr/bin/env node

const COMMANDS = [
  '/status', '/queue', '/cancel', '/drop', '/clear', '/newsession',
  '/projects', '/worktrees', '/worktree', '/rmworktree',
  '/history', '/stop', '/help',
];

/**
 * Parse a Telegram message into a command or task.
 *
 * Formats:
 *   /command args           → { type: 'command', cmd, args }
 *   /project/branch text    → { type: 'task', project, branch, text }
 *   /project text           → { type: 'task', project, branch: null, text }
 *   text                    → { type: 'task', project: 'default', branch: null, text }
 *
 * If /word is a known command, it's treated as a command.
 * Otherwise /word is treated as a project alias.
 */
export function parseMessage (text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('/')) {
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/@\w+$/, ''); // strip @botname

    // Known command
    if (COMMANDS.includes(cmd)) {
      return {
        type: 'command',
        cmd,
        args: parts.slice(1).join(' '),
      };
    }

    // Not a known command → treat as /project[/branch] task
    const projectMatch = trimmed.match(/^\/(\S+)\s+([\s\S]+)$/);
    if (projectMatch) {
      const target = projectMatch[1];
      const taskText = projectMatch[2].trim();

      const slashIndex = target.indexOf('/');
      if (slashIndex > 0) {
        return {
          type: 'task',
          project: target.substring(0, slashIndex),
          branch: target.substring(slashIndex + 1),
          text: taskText,
        };
      }
      return {
        type: 'task',
        project: target,
        branch: null,
        text: taskText,
      };
    }
  }

  // Plain text → default project
  return {
    type: 'task',
    project: 'default',
    branch: null,
    text: trimmed,
  };
}

/**
 * Parse /project or /project/branch from command args.
 * Returns { project, branch, rest } or null.
 */
export function parseTarget (args) {
  if (!args) {
    return null;
  }
  const match = args.trim().match(/^\/(\S+)/);
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
