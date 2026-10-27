# Changelog

Each release bumps `version` in both `package.json` and `kit.config.json` and adds a section here.
`kit lint` fails when the two versions differ or when this file has no section for the current one.
Synced repos compare their `.kit/manifest.json` version against `kit.config.json` (`kit doctor`).

## [0.3.0] - 2026-10-27

### Added

- Hub repos can run Claude from a `workspace` (its agents, CLAUDE.md and hooks) with `--add-dir <worktree>`, a prompt fence and an absolute brief path; stage agents via `agents.{plan,code,review,test}` and `engines.<stage>.agent` (`claude --agent`), overridable per ticket.
- `wiki`: repo notes injected into the plan, code, review and test prompts (12k chars).
- `test: true`: an agent test stage after review with a `VERDICT: PASS|FAIL|BLOCKED` contract; FAIL loops back to code within `fixIterations`; the report is `test.md`.
- `worktree` and `branch` patterns, `fetchBase` (branch from a fresh `origin/<base>`, refuse a branch already on origin), and tracker `key`/`url` on tickets (`kit hub add --key`).
- `commands.cleanup|evidence|publish|notify` with `{ticket} {id} {repo} {worktree} {branch} {base} {dir} {tickets}` placeholders and `KIT_*` env vars. With `publish` the ticket goes straight to `pr_open`; evidence and publish failures resume from that step.
- Control panel: **Import** from `import.command`, Tests / Evidence (gallery) / Published tabs, a Notify button per ticket and a multi-select on PR cards (one run per notify command), repo **Advanced (JSON)** settings, test engine and stage agents in Settings. CLI: `kit hub import`, `kit hub notify`, `--verify none`.

### Changed

- Headless Claude on Windows gets the `PowerShell` tool next to `Bash` (with only `Bash` listed it had no shell at all); deny rules now also cover `git * push*`-style commands (`git -C <dir> push`) and `git switch`/`stash`/`rebase`.
- New ticket branches are created with `--no-track`, so a branch cut from `origin/<base>` never pushes to `<base>` by accident.
- `setup` commands get the same placeholders. Repo info's list of `.wiki` pages is now `wikiFiles` (it shadowed the new `wiki` field).

## [0.2.1] - 2026-10-27

### Added

- Control panel: Auto / Light / Dark switch in the top bar, next to the nav links. Auto follows the OS; a choice is remembered per browser and applied before first paint.

## [0.2.0] - 2026-10-27

### Added

- `kit adopt [repo] [--write]`: inspects a repo that already has its own agents, skills and rules, and proposes a `.kit/config.json` with one reason per setting.
- `kit uninstall [repo] [--dry]`: removes everything `kit sync` installed; locally edited files, seeded docs and `.kit/config.json` stay.
- `namespace`: installs `<ns>-planner`, `<ns>-route/`, `/<ns>:spec`, `<ns>-secret-guard.mjs`, rewriting every cross-reference.
- `roles`: point a kit agent or skill at the project's own (`{"reviewer": "code-reviewer"}`) instead of installing a second copy.
- `install`: per kind (`agents skills commands hooks packs templates`) `true`, `false` or a list of names; settings entries for dropped hooks/skills are dropped too, and references to missing items are reported.
- `footprint: "untracked"`: kit files are hidden via a managed block in `.git/info/exclude` and settings go to `.claude/settings.local.json`, so `git status` stays clean.
- `rootMd.mode`: `block` (default) · `warn` · `off` for the CLAUDE.md/AGENTS.md line guard.
- `memory.dir`: move the wiki; seeds and every `.wiki` reference follow.
- `delegate.engine: "none"`: Claude-only installs, with no delegate agent/skill or `kit-worker` and no opencode/`delegable` text in plan, route and execute. Kit sources use `{{#delegate}}…{{/delegate}}` / `{{^delegate}}…{{/delegate}}` and `requires: delegate`.
- Repo-local packs in `.kit/local/packs/<name>/`; new `angular` and `react-native` packs.
- `kit lint` checks the conditional markers and that the release version is consistent.

### Changed

- A file that exists in the repo but was not installed by the kit is never overwritten, not even with `--force`; sync lists it separately.
- Settings merges record the entries the kit added (`.kit/manifest.json` → `settings`), so later syncs and `uninstall` remove only those. Repos synced with 0.1.0 have no record; entries merged then stay.
- The `@AGENTS.md` import note and the root-md budget only apply when they can matter (OpenCode/Codex enabled, guard not off).
- Control panel: pack overrides go to `.kit/local/packs/`, and namespaced files map back to their kit names.

## [0.1.0] - 2026-10-10

### Added

- Initial release: role agents, skills, commands and hooks for Claude Code, OpenCode and Codex; `kit sync`, `diff`, `doctor`, `detect`, `lint`; language packs; the hub ticket loop with the control panel and Telegram control.
- `kit new <dir>` and `/kit-new <idea>` for starting projects.
