#!/usr/bin/env node

/**
 * Cross-platform linker for sharing Claude Code skills with Codex.
 *
 * Recommended structure:
 *
 *   .claude/skills/          canonical skills storage
 *   .agents/skills -> ../.claude/skills
 *
 * This script intentionally links ONLY compatible entities.
 * It does NOT link:
 *   - .claude/agents    -> Codex agents use .codex/agents/*.toml
 *   - .claude/commands  -> migrate commands to skills instead
 *   - .claude/settings  -> Codex uses .codex/config.toml / hooks.json
 *   - .mcp.json         -> Codex MCP uses .codex/config.toml
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const LINK_MAPPINGS = [
  {
    name: 'skills',
    source: '.claude/skills',
    link: '.agents/skills',
    type: 'dir',
  },
  {
    name: 'skills',
    source: '.claude/skills',
    link: '.qwen/skills',
    type: 'dir',
  },
];

function parseArgs(argv) {
  const result = {
    mode: 'setup',
    repo: process.cwd(),
    dryRun: false,
    force: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--dry-run') {
      result.dryRun = true;
    } else if (arg === '--force') {
      result.force = true;
    } else if (arg === '--remove') {
      result.mode = 'remove';
    } else if (arg === '--status') {
      result.mode = 'status';
    } else if (arg === '--repo') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value after --repo');
      }
      result.repo = path.resolve(value);
      i += 1;
    } else if (arg.startsWith('--repo=')) {
      result.repo = path.resolve(arg.slice('--repo='.length));
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional[0]) {
    const mode = positional[0];
    if (!['setup', 'remove', 'status'].includes(mode)) {
      throw new Error(`Unknown mode: ${mode}. Use setup, remove, or status.`);
    }
    result.mode = mode;
  }

  return result;
}

function log(message) {
  process.stdout.write(`${message}${os.EOL}`);
}

function warn(message) {
  process.stderr.write(`WARN: ${message}${os.EOL}`);
}

function pathInfo(targetPath) {
  try {
    const stat = fs.lstatSync(targetPath);
    return {
      exists: true,
      isSymbolicLink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        exists: false,
        isSymbolicLink: false,
        isDirectory: false,
        isFile: false,
      };
    }
    throw error;
  }
}

function realpathSafe(targetPath) {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function normalizeForCompare(targetPath) {
  const resolved = path.resolve(targetPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameResolvedPath(a, b) {
  const realA = realpathSafe(a) || path.resolve(a);
  const realB = realpathSafe(b) || path.resolve(b);

  return normalizeForCompare(realA) === normalizeForCompare(realB);
}

function readLinkTargetAbsolute(linkPath) {
  const raw = fs.readlinkSync(linkPath);
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.resolve(path.dirname(linkPath), raw);
}

function ensureDir(dirPath, dryRun) {
  if (pathInfo(dirPath).exists) {
    return;
  }

  if (dryRun) {
    log(`[dry-run] mkdir -p ${dirPath}`);
    return;
  }

  fs.mkdirSync(dirPath, { recursive: true });
}

function createDirectoryLink(sourcePath, linkPath, dryRun) {
  const parentDir = path.dirname(linkPath);
  ensureDir(parentDir, dryRun);

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const targetForLink =
    process.platform === 'win32' ? path.resolve(sourcePath) : path.relative(parentDir, sourcePath) || '.';

  if (dryRun) {
    log(`[dry-run] link ${linkPath} -> ${targetForLink}`);
    return;
  }

  fs.symlinkSync(targetForLink, linkPath, linkType);
}

function setupMapping(repoRoot, mapping, options) {
  const sourcePath = path.resolve(repoRoot, mapping.source);
  const linkPath = path.resolve(repoRoot, mapping.link);

  ensureDir(sourcePath, options.dryRun);

  const link = pathInfo(linkPath);

  if (!link.exists) {
    createDirectoryLink(sourcePath, linkPath, options.dryRun);
    log(`OK: created ${mapping.link} -> ${mapping.source}`);
    return;
  }

  if (link.isSymbolicLink) {
    let currentTarget = null;

    try {
      currentTarget = readLinkTargetAbsolute(linkPath);
    } catch {
      currentTarget = null;
    }

    if (sameResolvedPath(linkPath, sourcePath)) {
      log(`OK: ${mapping.link} already points to ${mapping.source}`);
      return;
    }

    if (!options.force) {
      warn(
        `${mapping.link} is already a link, but it does not point to ${mapping.source}. ` +
          `Use --force to replace it. Current target: ${currentTarget || 'unknown'}`,
      );
      return;
    }

    if (options.dryRun) {
      log(`[dry-run] remove existing link ${linkPath}`);
    } else {
      fs.rmSync(linkPath, { force: true });
    }

    createDirectoryLink(sourcePath, linkPath, options.dryRun);
    log(`OK: replaced ${mapping.link} -> ${mapping.source}`);
    return;
  }

  warn(
    `${mapping.link} already exists and is not a symlink/junction. ` +
      `I will not overwrite real files/directories. Move it manually first.`,
  );
}

function removeMapping(repoRoot, mapping, options) {
  const sourcePath = path.resolve(repoRoot, mapping.source);
  const linkPath = path.resolve(repoRoot, mapping.link);

  const link = pathInfo(linkPath);

  if (!link.exists) {
    log(`OK: ${mapping.link} does not exist`);
    return;
  }

  if (!link.isSymbolicLink) {
    warn(`${mapping.link} exists but is not a symlink/junction. Skipping.`);
    return;
  }

  const pointsToExpectedTarget = sameResolvedPath(linkPath, sourcePath);

  if (!pointsToExpectedTarget && !options.force) {
    let currentTarget = 'unknown';
    try {
      currentTarget = readLinkTargetAbsolute(linkPath);
    } catch {
      // keep unknown
    }

    warn(
      `${mapping.link} is a link, but it does not point to ${mapping.source}. ` +
        `Use --force if you still want to remove it. Current target: ${currentTarget}`,
    );
    return;
  }

  if (options.dryRun) {
    log(`[dry-run] remove link ${linkPath}`);
    return;
  }

  fs.rmSync(linkPath, { force: true });
  log(`OK: removed ${mapping.link}`);
}

function statusMapping(repoRoot, mapping) {
  const sourcePath = path.resolve(repoRoot, mapping.source);
  const linkPath = path.resolve(repoRoot, mapping.link);

  const source = pathInfo(sourcePath);
  const link = pathInfo(linkPath);

  log(`\n[${mapping.name}]`);
  log(`source: ${mapping.source} ${source.exists ? 'exists' : 'missing'}`);
  log(`link:   ${mapping.link} ${link.exists ? 'exists' : 'missing'}`);

  if (link.exists && link.isSymbolicLink) {
    let target = 'unknown';
    try {
      target = readLinkTargetAbsolute(linkPath);
    } catch {
      // keep unknown
    }

    const ok = source.exists && sameResolvedPath(linkPath, sourcePath);
    log(`target: ${target}`);
    log(`status: ${ok ? 'OK' : 'MISMATCH'}`);
    return;
  }

  if (link.exists && !link.isSymbolicLink) {
    log('status: EXISTS_BUT_NOT_LINK');
    return;
  }

  log('status: NOT_LINKED');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repo);

  if (!pathInfo(repoRoot).exists) {
    throw new Error(`Repository path does not exist: ${repoRoot}`);
  }

  log(`repo: ${repoRoot}`);
  log(`mode: ${options.mode}${options.dryRun ? ' dry-run' : ''}${options.force ? ' force' : ''}`);

  for (const mapping of LINK_MAPPINGS) {
    if (options.mode === 'setup') {
      setupMapping(repoRoot, mapping, options);
    } else if (options.mode === 'remove') {
      removeMapping(repoRoot, mapping, options);
    } else if (options.mode === 'status') {
      statusMapping(repoRoot, mapping);
    }
  }

  log('');
  log('Note: only skills are linked because they are the compatible shared entity.');
  log('Do not symlink .claude/agents, .claude/commands, settings, hooks, or MCP config directly.');
}

try {
  main();
} catch (error) {
  process.stderr.write(`ERROR: ${error.message}${os.EOL}`);
  process.exit(1);
}
