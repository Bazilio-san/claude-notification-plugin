#!/usr/bin/env node
/**
 * Publish package to npm.
 * Usage:
 *   node scripts/publish.js            # bumps patch version, stages tracked modifications, commits, tags, pushes, publishes
 *   node scripts/publish.js --no-bump  # publishes current version as-is (no bump)
 *   node scripts/publish.js --add-all  # also stages untracked files (git add --all)
 *   node scripts/publish.js --help
 *
 * Default staging behavior: `git add -u` — modified tracked files go in (incl. the bumped package.json / plugin.json).
 * Untracked files are ignored unless --add-all is passed.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const c = '\x1b[35m';
const y = '\x1b[33m';
const r = '\x1b[31m';
const g = '\x1b[32m';
const c0 = '\x1b[0m';

const args = process.argv.slice(2);
const noBump = args.includes('--no-bump') || args.includes('-n');
const addAll = args.includes('--add-all') || args.includes('-a');

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`Usage: node scripts/publish.js [--no-bump|-n] [--add-all|-a]
  --no-bump, -n   Publish current version without bumping the patch number
  --add-all, -a   Also stage untracked files (git add --all).
                  By default only modified tracked files are staged (git add -u).
`);
  process.exit(0);
}

function log (color, msg) {
  process.stdout.write(`${color}${msg}${c0}\n`);
}

function run (cmd, opts = {}) {
  try {
    const result = execSync(cmd, { encoding: 'utf-8', stdio: opts.stdio || 'pipe', cwd: opts.cwd || projectRoot });
    return result ? result.trim() : '';
  } catch (e) {
    if (opts.ignoreError) {
      return '';
    }
    log(r, `**** ERROR running: ${cmd} ****`);
    log(r, e.stderr || e.message);
    throw e;
  }
}

function fail (msg) {
  log(r, msg);
  process.exit(1);
}

function readJson (filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function bumpPatch (version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function setJsonVersion (filePath, newVer) {
  const content = readFileSync(filePath, 'utf-8');
  writeFileSync(filePath, content.replace(/("version"\s*:\s*")[\d.]+(")/,  `$1${newVer}$2`), 'utf-8');
}

function stageChanges (cwd) {
  // -u stages modifications/deletions to tracked files (incl. the bumped package.json/plugin.json),
  // but does NOT include untracked files. --add-all switches to `git add --all` (also untracked).
  const stageCmd = addAll ? 'git add --all' : 'git add -u';
  run(stageCmd, { cwd });
  return run('git diff --cached --name-only', { cwd });
}

// ── Main ──

const expectedBranch = 'master';

const branch = run('git symbolic-ref --short HEAD');
if (branch !== expectedBranch) {
  fail(`${y}**** git branch should be ${c}${expectedBranch}${y}, current: ${c}${branch}${y} ****`);
}

// 1. Bump version
const pkg = readJson(join(projectRoot, 'package.json'));
const oldVersion = pkg.version;
const repoName = pkg.name;

let newVersion;
if (noBump) {
  newVersion = oldVersion;
  log(y, `**** Skipping version bump, publishing current ${g}${newVersion}${y} ****`);
} else {
  newVersion = bumpPatch(oldVersion);
  log(c, `**** Bumping version of ${g}${repoName}${c}: ${y}${oldVersion}${c} -> ${g}${newVersion}${c} ****`);

  setJsonVersion(join(projectRoot, 'package.json'), newVersion);

  const pluginJsonPath = join(projectRoot, '.claude-plugin', 'plugin.json');
  if (existsSync(pluginJsonPath)) {
    setJsonVersion(pluginJsonPath, newVersion);
  }

  log(g, `  ${repoName}@${newVersion}`);
}

// 2. Stage, commit & push (only if anything is staged)
const staged = stageChanges(projectRoot);
if (staged) {
  run(`git commit --no-verify -m "${newVersion}"`);
  run(`git push origin refs/heads/${expectedBranch}:${expectedBranch}`);
  log(g, '**** Pushed commit ****');
} else {
  log(y, '**** Nothing staged, skipping git commit/push ****');
}

// 3. Tag & push tag (idempotent: skip if tag already exists)
const tagName = `v${newVersion}`;
const tagExists = run(`git rev-parse -q --verify "refs/tags/${tagName}"`, { ignoreError: true });
if (tagExists) {
  log(y, `**** Tag ${tagName} already exists, skipping tag creation ****`);
} else {
  run(`git tag "${tagName}"`);
  run(`git push origin "${tagName}"`);
  log(g, `**** Tagged ${tagName} ****`);
}

// 4. npm publish
log(c, '**** Publishing to npm ****');
run('npm publish', { stdio: 'inherit' });

// 5. Bump marketplace
const marketplacePathFile = join(__dirname, 'path-to-markeplace-project.local.txt');
if (existsSync(marketplacePathFile)) {
  const marketplaceJson = readFileSync(marketplacePathFile, 'utf-8')
    .split('\n')[0].trim().replace(/\\/g, '/');

  if (existsSync(marketplaceJson)) {
    const marketplaceDir = dirname(dirname(marketplaceJson));
    const mpData = readJson(marketplaceJson);
    const mpOldVersion = mpData.metadata?.version;

    if (mpOldVersion) {
      const mpNewVersion = bumpPatch(mpOldVersion);
      log(c, `**** Bumping marketplace version: ${y}${mpOldVersion}${c} -> ${g}${mpNewVersion}${c} ****`);
      setJsonVersion(marketplaceJson, mpNewVersion);

      // Update plugin version in marketplace README
      const marketplaceReadme = join(marketplaceDir, 'README.md');
      if (existsSync(marketplaceReadme)) {
        let readme = readFileSync(marketplaceReadme, 'utf-8');

        // Add Version column if missing
        if (/\| Plugin \| Description \|/.test(readme) && !/Version/.test(readme)) {
          readme = readme
            .replace('| Plugin | Description |', '| Plugin | Version | Description |')
            .replace('|--------|-------------|', '|--------|---------|-------------|');
          // Update existing plugin rows: | [name](url) | desc | -> | [name](url) | ver | desc |
          readme = readme.replace(
            /\| (\[claude-notification-plugin]\([^)]+\)) \| (.+) \|/,
            `| $1 | ${newVersion} | $2 |`,
          );
        } else {
          // Version column exists — update the version value
          readme = readme.replace(
            /\| (\[claude-notification-plugin]\([^)]+\)) \| [\d.]+ \|/,
            `| $1 | ${newVersion} |`,
          );
        }

        writeFileSync(marketplaceReadme, readme, 'utf-8');
        log(g, `**** Updated marketplace README with version ${newVersion} ****`);
      }

      const mpStaged = stageChanges(marketplaceDir);
      if (mpStaged) {
        run(`git commit --no-verify -m "${mpNewVersion}"`, { cwd: marketplaceDir });
        run('git push', { cwd: marketplaceDir });
        log(g, '**** Marketplace pushed ****');
      } else {
        log(y, '**** Marketplace: nothing staged, skipping commit/push ****');
      }
    }
  } else {
    log(y, `**** Marketplace file not found: ${marketplaceJson} ****`);
  }
}

log(g, `\n**** Done: ${repoName}@${newVersion} ****`);
