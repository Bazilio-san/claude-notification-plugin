---
name: change-log
description: "Maintain CHANGELOG.md for claude-notification-plugin following Keep a Changelog 1.1.0 + SemVer. Bootstraps the file if missing, manages the [Unreleased] section during a session, promotes it to a versioned release synced with `scripts/publish.js` (tags `v<version>`), and keeps GitHub compare links correct. Triggers: 'обнови changelog', 'допиши changelog', 'добавь в чейнджлог', 'актуализируй changelog', 'changelog запись', 'перед публикацией обнови changelog', 'update changelog', 'add changelog entry', 'release notes', 'промотай unreleased в релиз'."
---

# CHANGELOG maintenance

Keeps `CHANGELOG.md` in the repo root in lock-step with the publish pipeline. The file is the source of truth for "what changed for users between npm versions" — npm consumers, plugin users and the marketplace README all derive context from it.

Format: **[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)**. Versioning: **[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html)**. Language: **English** (the package is published to npm, audience is international).

## When to invoke this skill

- Before running `node scripts/publish.js` — promote `[Unreleased]` to a new version block.
- During a session, after finishing any user-facing change (env var, CLI flag, hook event, notifier channel, listener command, config key) — append to `[Unreleased]`.
- When `CHANGELOG.md` is missing — bootstrap it (one-time).
- When the user asks "что изменилось в версии X" — read the relevant block; do NOT reconstruct from `git log`.

## What goes in (user-facing only)

| In | Out |
|---|---|
| New CLI subcommand / flag (`bin/cli.js`, `bin/listener-cli.js`) | Internal refactors, file renames, code reorganization |
| New / removed env var (`CLAUDE_NOTIFY_*`) | Lint rule changes, formatting |
| New config key in `~/.claude/claude-notify.config.json` | `package-lock.json` updates |
| New / changed Telegram bot command (`/pty`, `/cancel`, `/clear`, …) | Test scaffolding |
| New notification channel or hook event handled | Bumping dev dependencies |
| Behavior change visible to the user (default value flip, message wording, sound file) | CI/build tweaks |
| Bug fix that the user could observe (silent listener, lost signals, wrong path) | Bug fixes for code paths never released |
| Security fix touching token/PII handling | Comment / docstring edits |
| Breaking change → **must** be flagged `**BREAKING:**` and explained | "WIP", placeholder entries |

If a change only matters to maintainers, leave it out — the commit message already records it.

## File structure (canonical template)

When bootstrapping or editing, this exact shape MUST be preserved:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- …

### Changed
- …

### Fixed
- …

## [1.1.102] - 2026-05-11

### Added
- New `--add-all` flag for `scripts/publish.js` to also stage untracked files.

### Fixed
- Tag creation now idempotent — re-running publish for the same version no longer fails.

[Unreleased]: https://github.com/Bazilio-san/claude-notification-plugin/compare/v1.1.102...HEAD
[1.1.102]: https://github.com/Bazilio-san/claude-notification-plugin/compare/v1.1.101...v1.1.102
```

Rules:
- **Six allowed sections**, in this fixed order: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`. Omit sections that have no entries — never write empty headers.
- **Reverse chronological** ordering of versions (newest first; `[Unreleased]` always at the top).
- **Date format**: ISO 8601 `YYYY-MM-DD`. Use the date the version is *published*, not the date of the first commit.
- **Compare links** at the bottom, one per version, plus `[Unreleased]` pointing at `v<latest>...HEAD`.
- **Entry voice**: imperative + user-perspective. ✅ "Add `/pty` Telegram command for live console snapshot." ❌ "Refactored `pty-runner.js` to expose buffer." ❌ "I added a new command."
- **No marketing language** (`blazingly fast`, `magnificent`, `100% reliable`). Plain technical statements only.
- **Reference issues / PRs** when available: `(#42)` after the entry.
- **Security entries**: include CVE id and severity when known. ✅ `Fix token leak in PTY buffer log (CVE-2026-XXXX, severity: high).` A bare `fix security issue` line is not informative enough — downstream consumers need to know what to audit.

## Bootstrap procedure (CHANGELOG.md does NOT exist)

1. Read current `package.json` → get `version`.
2. Read recent tags: `git tag --list "v*" --sort=-v:refname` → take the latest as the "starting point".
3. Create `CHANGELOG.md` with:
   - Header (template above).
   - Empty `## [Unreleased]` section.
   - One initial release block for the current `package.json` version dated today, body: `### Added\n- Initial published release.` (or, if user wants reconstruction, see step 4).
   - Two compare links: `[Unreleased]` and the initial version. Use `https://github.com/Bazilio-san/claude-notification-plugin/compare/...`.
4. **Optional reconstruction** — only if the user explicitly asks: walk recent tags via `git log v<prev>..v<curr> --oneline` and propose entries for each version. Wait for approval before writing — git history alone is not authoritative for "user-facing" classification.
5. Commit with message `docs: bootstrap CHANGELOG.md` on a normal commit (do NOT amend the version-bump commit; CHANGELOG isn't part of a release per se until the next publish).

## Mid-session entries (during development)

When a user-facing change lands:

1. Open `CHANGELOG.md`, find `## [Unreleased]`.
2. Add a one-line entry under the right category (create the category header if absent — within the allowed six, in canonical order).
3. Do **not** assign a version number yet. Do **not** add a date. Do **not** touch compare links.

Example diff:
```diff
 ## [Unreleased]

 ### Added
 - Add `/pty &<alias>` Telegram command — returns 15-line tail of cleaned PTY buffer.
+- Add `CLAUDE_NOTIFY_AFTER_LISTENER` env var (`1`/`0`) to gate listener-triggered notifications.
```

Then update `README.md` to match (per `CLAUDE.md` Maintenance Rules — env vars and CLI flags must appear there too).

## Promoting [Unreleased] → version (at publish time)

This is the most critical flow. Run **before** `node scripts/publish.js`.

1. Determine the new version:
   - If user passed a specific number, use it.
   - Otherwise, mirror what `publish.js` would do: read `package.json` version, bump patch (or stay if the user will pass `--no-bump`).
2. Verify `[Unreleased]` is non-empty. If empty → ask the user whether the release truly is empty (rarely correct; if it is, this is usually a chore release and shouldn't bump a user-visible version).
3. Replace the `## [Unreleased]` heading with `## [Unreleased]\n\n## [<new>] - <YYYY-MM-DD>` (today's date — always check `<env>` "Today's date", never assume).
4. Move the entries that were under `[Unreleased]` to under the new version block. Leave `[Unreleased]` empty (it stays as a forward-pointing anchor).
5. Update compare links at the bottom:
   - `[Unreleased]` → `compare/v<new>...HEAD`
   - Add `[<new>]` → `compare/v<prev>...v<new>` (prev = the version that was the latest before this release).
6. Save the file. Stage with `git add CHANGELOG.md`.
7. **Don't** commit separately — `scripts/publish.js` runs `git add -u` and includes everything tracked-and-modified into the version commit. The CHANGELOG update will ride along in the same `vX.Y.Z` commit. (If staging via `--add-all` / untracked, no special handling needed.)
8. Now run `node scripts/publish.js`.

After publish:
- Tag `v<new>` exists → compare link is valid.
- `[Unreleased]` is the empty section ready to receive next-cycle entries.

## Breaking changes

Any breaking change in CLI args, config schema, hook event names, env vars, or Telegram commands MUST:
- Be marked with `**BREAKING:**` prefix on the entry.
- Include a one-line migration note (or link to a section in `README.md`).
- Trigger a **minor or major** bump (not patch). `scripts/publish.js` bumps patch by default — for a non-patch release the user must edit `package.json` manually first, then run `publish.js --no-bump`.

Example:
```markdown
### Changed
- **BREAKING:** `CLAUDE_NOTIFY_TELEGRAM_TOKEN` renamed to `CLAUDE_NOTIFY_TG_TOKEN`. Old name is no longer read. Migration: rename the env var and the `telegram.token` key in `~/.claude/claude-notify.config.json`.
```

## Yanked releases

If a published version turns out broken or unsafe and must be retracted (`npm deprecate`, GitHub release marked broken, plugin pulled from marketplace) — mark its block with `[YANKED]` next to the version:

```markdown
## [1.1.99] - 2026-05-09 [YANKED]

> Yanked: PTY listener crashed on Windows under any input containing CRLF. Fixed in [1.1.100]. Users on 1.1.99 should upgrade.

### Fixed
- …(original entries stay untouched)…
```

Rules:
- **Keep the original entries** under the yanked block — don't delete them; the historical record matters.
- **Add a `> Yanked: …` blockquote** right under the heading, explaining the reason in one sentence and linking to the fix version.
- **Do not reuse the version number.** The replacement release gets its own next version (e.g. 1.1.99 yanked → 1.1.100 fixes it).
- **Compare link stays** — `[1.1.99]: …compare/v1.1.98...v1.1.99` remains valid; the tag still exists.

(Per Keep a Changelog 1.1.0 §"Yanked releases".)

## What this skill does NOT do

- Does **not** auto-generate entries from `git log`. Conventional Commits are not enforced in this repo, and commit messages frequently describe internal mechanics that don't belong in a user-facing changelog.
- Does **not** publish or push. That's `scripts/publish.js`.
- Does **not** edit `package.json` / `.claude-plugin/plugin.json` versions. `scripts/publish.js` owns version numbers; this skill only writes the matching CHANGELOG block.
- Does **not** create empty version blocks "for the next release" — the next release is `[Unreleased]`.

## Quick checklist (use before every publish)

- [ ] `[Unreleased]` block contains at least one entry, OR the user confirmed an empty release is intentional.
- [ ] Each entry is user-facing, imperative, no marketing fluff.
- [ ] Sections appear in canonical order, no empty headers.
- [ ] Breaking changes flagged `**BREAKING:**` with migration note.
- [ ] Date is today's date verified from `<env>` (not from training cutoff).
- [ ] Compare links updated: `[Unreleased]` repointed, new version link added.
- [ ] `README.md` reflects the same user-facing surface (env vars, flags).
- [ ] File saved; `git add CHANGELOG.md` done so `publish.js`'s `git add -u` picks it up.
