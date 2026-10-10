---
name: delegate
description: Hand a fully specified coding task to an external CLI agent (opencode default, codex optional) to save Claude tokens. Use for delegable plan tasks or mechanical multi-file edits.
---
# Delegate
**Use when:** the change is fully specified (files, steps, acceptance command), a test or build check exists, and no design judgement is needed.
**Don't use for:** architecture decisions, security-sensitive code (auth, crypto, payments, RLS), unknown-cause debugging, or anything needing chat context.

1. Write `.kit/handoff/<slug>.md` from the template below. Reference paths; never paste file contents. ≤60 lines.
2. Run:
   `node .claude/skills/delegate/scripts/delegate.mjs .kit/handoff/<slug>.md [--engine opencode|codex] [--model provider/model] [--timeout 20]`
   It prints the worker's final lines, the exit code, and `git diff --stat`. The full log is in `.kit/handoff/<slug>.log` (read it only on failure, with a line range).
3. **Verify yourself:** run the Acceptance commands; read only the diff hunks of the listed files (`git diff -- <path>`).
4. **Failed?** Append a `## Fix` section (error excerpt ≤20 lines + what to change), re-run once. Still failing → take over (implementer) or report.

The default engine comes from `.kit/manifest.json` → `delegate.engine` (set per repo in `.kit/config.json`). The OpenCode worker runs as the `kit-worker` agent, with `git push/commit` and destructive commands denied.

~~~markdown
# Task: <imperative title>
Goal: <1–2 lines: the outcome, not the steps>
Read first: <≤10 paths; plan file + task id if any>
Change:
1. <precise step: file, function, signature, behaviour, edge cases>
Constraints: no new dependencies · don't modify <paths> · match existing style · never commit or push
Acceptance: `<command>` passes · <observable behaviour>
Report: ≤15 lines: files changed, acceptance results, open issues
~~~
