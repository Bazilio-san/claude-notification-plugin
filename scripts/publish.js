#!/usr/bin/env node
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

function replaceFirstVersion (filePath, oldVer, newVer) {
  const content = readFileSync(filePath, 'utf-8');
  writeFileSync(filePath, content.replace(oldVer, newVer), 'utf-8');
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
const newVersion = bumpPatch(oldVersion);
const repoName = pkg.name;

log(c, `**** Bumping version of ${g}${repoName}${c}: ${y}${oldVersion}${c} -> ${g}${newVersion}${c} ****`);

replaceFirstVersion(join(projectRoot, 'package.json'), oldVersion, newVersion);

const pluginJsonPath = join(projectRoot, '.claude-plugin', 'plugin.json');
if (existsSync(pluginJsonPath)) {
  replaceFirstVersion(pluginJsonPath, oldVersion, newVersion);
}

log(g, `  ${repoName}@${newVersion}`);

// 2. Commit & push
run('git add -A');
run(`git commit --no-verify -m "${newVersion}"`);
run(`git push origin refs/heads/${expectedBranch}:${expectedBranch}`);
log(g, '**** Pushed commit ****');

// 3. Tag & push tag
run(`git tag "v${newVersion}"`);
run(`git push origin "v${newVersion}"`);
log(g, `**** Tagged v${newVersion} ****`);

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
      replaceFirstVersion(marketplaceJson, mpOldVersion, mpNewVersion);

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
            /\| (\[claude-notification-plugin\]\([^)]+\)) \| (.+) \|/,
            `| $1 | ${newVersion} | $2 |`,
          );
        } else {
          // Version column exists — update the version value
          readme = readme.replace(
            /\| (\[claude-notification-plugin\]\([^)]+\)) \| [\d.]+ \|/,
            `| $1 | ${newVersion} |`,
          );
        }

        writeFileSync(marketplaceReadme, readme, 'utf-8');
        log(g, `**** Updated marketplace README with version ${newVersion} ****`);
      }

      run('git add -A', { cwd: marketplaceDir });
      run(`git commit --no-verify -m "${mpNewVersion}"`, { cwd: marketplaceDir });
      run('git push', { cwd: marketplaceDir });
      log(g, '**** Marketplace pushed ****');
    }
  } else {
    log(y, `**** Marketplace file not found: ${marketplaceJson} ****`);
  }
}

log(g, `\n**** Done: ${repoName}@${newVersion} ****`);
