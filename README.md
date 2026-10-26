# agentry

Token-lean agents, skills, commands and hooks for **Claude Code**, **OpenCode** and **Codex**.
You write them once here, then `kit sync` installs or updates them in any repo.

## Why (gaps in popular kits)
| Common problem | agentry |
|---|---|
| Full brainstorm → plan → TDD ceremony even for one-line fixes | `route` sizes each task S/M/L; small tasks skip planning |
| 50–100 agents whose descriptions load every session | 7 role agents + language **packs** installed only when the repo uses that stack |
| Separate install for each tool, so copies drift apart | One source, converted per tool (`adapters/`) |
| Updates overwrite local edits | Hash manifest: unmodified files update, edited ones are kept, `.kit/local/` overrides |
| CLAUDE.md grows without limit | ≤10 lines, enforced by a hook; knowledge lives in an LLM wiki (`.wiki/`) |
| All coding spends Claude tokens | `delegate` hands well-specified tasks to `opencode run` / `codex exec` |
| Subagents dump long output into the main chat | Every agent's reply is capped (≤20–30 lines, `path:line` anchors) |

Typical overhead in a synced repo: **~1k tokens** loaded every session (run `kit doctor` to see yours).

## Install
```bash
git clone https://github.com/nktnhan1310/agentry && cd agentry
npm link                                 # optional: `kit` command on PATH (Node ≥20, no dependencies)
```
Windows: double-click `kit-ui.cmd` to open the control panel.

## Start a new project
From any Claude Code or OpenCode session (any folder): `/kit-new <your idea>`. The agent then:
1. asks up to 3 questions;
2. scaffolds with the stack's official tool;
3. runs `kit new <dir>` (git init + sync + pack detection);
4. writes `.wiki/arch.md` and `.wiki/plans/mvp.md` (the MVP as tickets);
5. commits once tests pass;
6. offers to register the project with the hub.

Existing repo: `/kit-sync` in it, then `kit hub repo add .`.

## Use
```bash
node bin/kit.mjs install-global          # once: adds /kit-sync and /ticket to Claude Code + OpenCode
# in any repo:   /kit-sync               (or)   node <kit>/bin/kit.mjs sync .
node bin/kit.mjs diff <repo>             # dry run
node bin/kit.mjs doctor <repo>           # budgets, drift, wiki health, engine on PATH
node bin/kit.mjs lint && npm test        # before publishing kit changes
```

## Workflow in a repo
| Command | What it does |
|---|---|
| `/spec <task>` | route → S/M answer inline, L → `planner` writes `.wiki/plans/…` for approval |
| `/impl <plan or task>` | `execute`: delegable tasks → opencode, the rest → `implementer`; verify each |
| `/fix <bug>` | `debug`: reproduce → one hypothesis at a time → regression test → fix |
| `/audit [base]` | `reviewer` + `security` in parallel → one merged report |
| `/wiki query\|update\|lint\|ingest\|slim` | project memory (in Claude Code skills are `/wiki`, `/delegate`, `/verify` directly) |

## Layout
```
core/agents/     explorer(haiku) planner(opus) implementer tester reviewer(opus) security(opus) delegate kit-worker
core/skills/     route plan execute tdd debug verify review security-audit delegate wiki
core/commands/   spec impl fix audit wiki(opencode)
core/hooks/      root-md-guard (CLAUDE/AGENTS.md ≤10 lines), secret-guard (.env/key reads)
core/templates/  AGENTS.md, CLAUDE.md, .wiki seed            (written only if missing)
packs/           typescript react nextjs angular react-native dotnet sql python supabase   (auto-detected)
adapters/        claude → .claude/   opencode → .opencode/   codex → .agents/skills/
```
Canonical agent frontmatter: `name, description, model (haiku|sonnet|opus), tools [read, edit, bash, web], targets [claude, opencode], mode`.

## Existing projects (own agents, skills, rules)
```bash
kit adopt D:/my-repo            # read-only: proposes a .kit/config.json, with a reason per setting
kit adopt D:/my-repo --write    # write it, then preview with `kit diff`, then `kit sync`
kit uninstall D:/my-repo        # remove everything sync installed; edited files and .kit/config.json stay
```
| Setting | Effect |
|---|---|
| `namespace: "ak"` | installs `ak-planner`, `ak-route/`, `/ak:spec`, `ak-secret-guard.mjs`; every cross-reference is rewritten to match |
| `roles: {"reviewer": "code-reviewer", "tdd": "tdd"}` | the kit uses the project's own agent/skill instead of installing its copy |
| `install: {"hooks": ["secret-guard"], "commands": false, "templates": false}` | per kind (`agents skills commands hooks packs templates`): `true`, `false`, or a list of names; settings entries for dropped hooks/skills are dropped too |
| `footprint: "untracked"` | kit files are hidden via a managed block in `.git/info/exclude`, settings go to `.claude/settings.local.json`; `git status` stays clean |
| `rootMd: {"mode": "warn"}` | CLAUDE.md/AGENTS.md line guard: `block` (default), `warn` (adds context, never blocks), `off` (hook not installed) |
| `delegate: {"engine": "none"}` | Claude-only: no `delegate` agent/skill or `kit-worker`, and the plan/route/execute text drops opencode and `delegable` (delegable tasks go to `implementer`). `kit adopt` suggests it when neither opencode nor codex is on PATH |
| `memory: {"dir": "docs/ai"}` | where the wiki lives; seeds and every `.wiki` reference move with it |
- A file that exists in the repo but was not installed by the kit is **never overwritten**, not even with `--force`; sync lists it.
- Settings: sync records which entries it added and removes only those (on uninstall, or when a hook/skill is dropped). Repos synced before 0.2.0 have no record, so entries merged back then stay.
- Your own packs: `.kit/local/packs/<name>/SKILL.md`. Installed when it has no detection rule; give it `packs.<name>` in `.kit/config.json` to detect it instead.

## Per-repo config
- `.kit/config.json` is deep-merged over `kit.config.json`, e.g. `{"tools":["claude","opencode","codex"],"delegate":{"model":"opencode/big-pickle"}}`.
- `.kit/local/{agents,commands,skills,hooks}/`: a file with the same name replaces the kit's version; new names are added.
- `.kit/manifest.json`: installed version + file hashes (commit it). `.kit/handoff/` holds delegate briefs and logs (gitignored).

## Token rules (checked by `kit lint` / `kit doctor`)
CLAUDE.md/AGENTS.md ≤10 lines · descriptions ≤200 chars · agent body ≤40 lines · SKILL.md ≤150 · pack ≤80 · wiki index ≤80, page ≤200, log ≤200 (archived) · agent replies ≤20–30 lines · hooks print nothing on success.

Conditional text in kit sources: `{{#delegate}}…{{/delegate}}` is kept only with an external engine, `{{^delegate}}…{{/delegate}}` only without one; a source with `requires: delegate` in its frontmatter is skipped without one. `kit lint` rejects unknown flags and unbalanced markers.

Releasing: bump `version` in both `package.json` and `kit.config.json` and add a section to [CHANGELOG.md](CHANGELOG.md); `kit lint` fails until all three agree.

## Hub: background ticket loop + phone control
Tickets live locally in `~/.kit-hub` (never in a repo). A daemon works each ticket in its own git worktree and **stops before push/PR**:
```
ticket → worktree kit/PIX-3-slug → setup → plan (Claude opus, or skipped for --quick)
       → code (opencode) ⇄ verify (your test/build cmds, no tokens) ⇄ fix (opencode)
       → review (Claude, diff inlined; skipped under 20 changed lines) → local commit
       → STATUS review → Telegram card [Diff] [Approve → PR] [Request changes] [Reject]
Approve → git push + gh pr create.  Changes → loops again with your feedback.
```
Setup (once):
```bash
kit hub repo add D:/my-repo --verify "pnpm test && pnpm build"   # setup/verify auto-detected if omitted
kit hub telegram <token from @BotFather>    # then send /pair <code> to the bot from your phone
kit hub ntfy                                # optional one-line push notifications
kit hub start                               # background daemon; `kit hub autostart` to start at login
```
Control panel: `kit ui` opens http://127.0.0.1:7878, served by the daemon and starting it if needed. It is local only, and changes require the `x-kit-ui` header.
- **Board**: counters, the workflow strip (which engine/model runs each step) and tickets by column with their PR links. **Ticket**: live stage, plan (editable before coding), questions, the finished-ticket report, colored diff, per-stage logs, history, plus Approve / Request changes / Re-plan / Retry / Stop / Reject.
- **Pull requests**: every PR of each hub repo on GitHub (via `gh`, hub-made or not), filtered by open/merged/closed, linked to its ticket.
- **Repos**: the repo's tickets with Start / Stop / Start all backlog; **Autopilot** per repo: pause, auto-run backlog (when nothing of the repo is in flight, queue its oldest backlog ticket, so the next starts after the previous is merged or rejected; a failed or needs-info ticket holds the line), auto-approve (push + PR once verify and review pass), auto-merge (squash/merge/rebase; uses GitHub auto-merge when enabled, else merges at once; a PR that conflicts with its base gets the base merged in, conflicts resolved by `engines.resolve` (claude · opus by default, `off` to disable), verify re-run, then pushed and merged; one try per base/head pair); loop settings (base/setup/verify); Preview sync / Sync / Doctor; every installed agent/command/skill/pack/hook with ok/modified/missing status; one-click **override** into `.kit/local/`; edit the wiki and AGENTS.md.
- **Kit**: browse and edit kit sources with line budgets; saving runs lint. **Settings**: light/dark/system theme, engines/models, limits, PR draft, ntfy. Pause/resume the loop from the header; press `N` for a new ticket.

When a ticket finishes, a cheap Claude call (`engines.summary`, haiku by default, `off` to disable) writes a two-part report: **For everyone** (plain language) and **For engineers** (key changes, risks, how to test). It goes into the Telegram card, the Result tab and the PR description.

**Bugs**: **New ticket → Bug** in the UI (`B` opens it in bug mode), or `kit hub bug <repo> "<title>" --img shot.png --severity high`. A bug is a ticket with `kind: bug`: same loop, but the Opus planner reads the screenshots first, must name the root cause (`path:line`) and put a failing regression test first, and writes what the screenshots show in words (the coder never sees images). Its status reads Open → Fixing → Fix ready → Fix in PR → Fixed → **Verified** (or Needs info / Fix failed / Won't fix); the board filters Features / Bugs. On a fixed bug, **Verified** confirms it and **Still broken…** opens a new linked bug with the same screenshots (`kit hub verify|broken <id>`, or the Telegram buttons). Screenshots are resized in the browser to ≤1568px (≈1.8k tokens each, ~1 token per 28×28 px) and only the plan step sees them.

**E2E tests (Playwright, no tokens)**: Repos → *End-to-end tests* → **Run now**, `kit hub e2e <repo>`, or every N hours (`e2e.everyHours`). It runs the suite on a clean checkout of the latest base in its own worktree (`CI=1`, so `webServer` starts the app and retries separate flaky tests), then turns each failing test into a bug ticket with its error text and failure screenshot. Reruns add "still failing" to the open bug instead of filing a duplicate; more than `maxBugs` failures (default 5) become one grouped bug, since they usually share a cause. When a fixed bug's test passes again, the bug is marked Verified. Filed bugs wait in the backlog unless *Start fixing right away* is on. *Also run in each ticket's Verify step* adds the suite to verify with the terse `line` reporter, so a failure costs the coder only text. Auto-detected from `playwright.config.*`; set `use: { screenshot: 'only-on-failure' }` there.

Start a ticket from anywhere (all go to the same queue):
- Claude Code / OpenCode session in the repo: `/ticket <request>`. The agent drafts the title and description from the conversation, then queues it (unregistered repos are added automatically). Installed by `kit install-global`.
- Phone: `/new <repo> <title>` (next lines = description), `/quick …`, `/list`, `/t PIX-3`, `/status`, `/pause`.
- Terminal: `kit hub add <repo|path> "<title>" [--quick]`, `kit hub ls`, `kit hub show PIX-3`, `kit hub approve PIX-3`.

Models: `kit hub config engines.plan.model opus|sonnet` (also `engines.review.model`, `engines.code.model`, e.g. `opencode/big-pickle`).
Test a ticket locally before approving: the card shows its worktree path.

### Workspace repos: own agents, a test stage, publishing through your scripts
Optional per-repo fields (Repos → Advanced, or `hub.json`) for teams that already have agents, review rules and a PR process. A repo without them works as above.
```jsonc
"my-api": {
  "path": "D:/work/my-api", "base": "staging", "fetchBase": true,   // branch from a freshly fetched origin/staging
  "workspace": "D:/work",                     // Claude starts here (its agents, CLAUDE.md, hooks) with --add-dir <worktree>
  "wiki": ["D:/work/notes/my-api.md"],       // injected into the plan/code/review/test prompts (12k chars max)
  "worktree": "D:/work-wt/{ticket}/{repo}", "branch": "{ticket}",
  "verify": ["dotnet build -warnaserror"],    // build check only; [] or `--verify none` = no check
  "test": true,                               // agent test stage after review: VERDICT PASS | FAIL (back to code) | BLOCKED
  "agents": { "code": "backend-developer", "review": "code-reviewer", "test": "test-runner" },
  "commands": {
    "cleanup": "…",                           // before `git worktree remove`; if it fails the worktree stays
    "evidence": "…",                          // writes screenshots / reports into {dir}/evidence/
    "publish": "…",                           // commits, pushes, opens the PR, comments; prints pr=<url> / comment=<url>
    "notify": "…"                             // the ticket's Notify button and multi-select; {tickets} = all picked keys
  }
}
```
Placeholders (also exported as `KIT_TICKET`, `KIT_WORKTREE`, …): `{ticket}` (tracker key, else hub id) `{id}` `{repo}` `{worktree}` `{branch}` `{base}` `{dir}` (the hub's ticket folder: brief, review, `test.md`, `evidence/`; publish may add `comment.md` and `pr-body.md`, shown under **Published**). Keys are limited to `A-Z a-z 0-9 . _ -`.
With `publish`, the loop goes code → verify → review → test → evidence → publish → `pr_open` without a human gate; a failed evidence or publish step retries from that step. Agents: ticket > repo `agents` > `engines.<stage>.agent`. **Import** (header) runs `import.command`, which prints `[{key, title, description, repo, url, agents, manual}]`; entries with `manual` are listed but cannot be picked. On Windows the headless shell tool is `PowerShell`, so write and test stages get both shells, each with the same git deny rules (`git push*` and `git * push*`, …).

Token saving in the loop: `--tools` + `--strict-mcp-config` cut each headless Claude call from ~22.6k to ~6.1k context tokens; Opus only for the single plan call, Sonnet for review; all coding and fixing runs on opencode; `--quick` tickets use no Claude at all unless the diff is ≥20 lines; `limits.claudeBudgetUsd` caps every call.

## Notes
- OpenCode reads `.claude/skills`, so skills are written once. When codex is enabled, set `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1` to avoid duplicates.
- Hooks are Node scripts (no bash/PowerShell differences). Requires Node ≥20.
