---
name: wiki
description: Project memory in .wiki/ (LLM-maintained wiki). Use to look up project context before exploring code, and to record decisions, conventions, and gotchas after a task.
---
# Wiki
`.wiki/` replaces long CLAUDE.md/AGENTS.md files; those stay ≤10 lines and point here. Only `index.md` is read up front.

Layout
- `index.md`: one line per page, `- [title](path) — questions it answers`. ≤80 lines.
- `log.md`: append-only, `YYYY-MM-DD | kind | summary | pages`. Kinds: feat, fix, decision, refactor, plan, ingest.
- `arch.md` (modules, entry points, data flow) · `conventions.md` (non-obvious rules) · `gotchas.md` (symptom → cause → fix)
- `decisions/NNNN-slug.md` (ADR ≤30 lines: context, decision, consequences) · `plans/` (from `plan`) · `domain/<topic>.md`

## query (cheap path)
1. Read `index.md`. 2. Open the 1–2 best pages. For long pages, `grep -n "^#" <page>` and read only the matching section.
3. Not there → explore the code (`explorer`), answer, then record it (update) if it took real digging.

## update (after M/L tasks, or whenever you learned something you had to dig for)
- Record only what the code doesn't say: why, constraints, traps, cross-module flows, external-system quirks, commands that aren't obvious.
- Edit the existing section instead of appending duplicates. New page only if none fits, and add it to `index.md`.
- Each fact ≤3 lines, anchored with `path` or a symbol name. Never copy code blocks longer than 5 lines.
- Append one `log.md` line.

## lint
Run `node .claude/skills/wiki/scripts/wiki-lint.mjs [--fix]`. It checks page ≤200 lines, index ≤80, log ≤200 (`--fix` archives old log lines to `log-archive/`), dead links, pages missing from the index, and backticked paths that no longer exist. Fix what it reports: split, merge, or delete stale facts.

## ingest (new or legacy repo)
Use `explorer` to read the README, manifests, entry points, and top-level folders. Write `arch.md` + `conventions.md` (≤150 lines total), then update `index.md` and `log.md`.

## slim (CLAUDE.md / AGENTS.md over 10 lines)
1. Move each section into the right page (`conventions.md`, `arch.md`, `domain/…`), deduplicating against existing content.
2. Rewrite AGENTS.md to ≤10 lines: name, stack, build/test/lint commands, "read `.wiki/index.md` first", workflow pointer.
3. CLAUDE.md becomes `@AGENTS.md` plus ≤2 Claude-only lines. Other rule files (`.cursorrules`, `copilot-instructions.md`) get the same pointer treatment if the user agrees.
