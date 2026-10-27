---
name: route
description: Size a coding task (S/M/L) and pick the cheapest safe workflow. Use at the start of any feature, fix, refactor, or "build X" request.
---
# Route
Decide the size once and state it in one line, e.g. `Route: M (3 files, design clear)`. Then follow that flow.

| Size | Signals | Flow |
|---|---|---|
| S | ≤2 files, ≤~40 lines, behaviour obvious | Edit → run the nearest test/build → `verify`. No plan, no subagents. |
| M | 3–8 files or one new unit, design clear | ≤10-bullet plan in chat → implement{{#delegate}} or `delegate`{{/delegate}} → `verify` → `reviewer` on the diff. |
| L | new module/feature, unclear design, schema/API change, cross-cutting | `plan` skill → user approves → `execute` → `verify` → `reviewer` + `security` in parallel. |

Overrides
- Bug with unknown cause → `debug` skill first, then size the fix.
- Touches auth, payments, secrets, PII, permissions, or migrations → at least M, and add `security`.
- User says "quick", "just", or "small" → S, unless a security override applies.
- Unsure between two sizes → pick the smaller one and escalate if it grows.

Token discipline (applies to every size)
- Read `.wiki/index.md` before exploring; a page may already answer it.
- Searches spanning >3 files → `explorer` agent, so results stay out of the main context.
- Read line ranges, not whole files. Don't re-read files you just wrote.
- Subagents get paths and task ids, not pasted content. They return ≤20–30 lines.
{{#delegate}}- M/L tasks with a precise spec and existing tests → `delegate` (runs on opencode, not Claude tokens).
{{/delegate}}- Don't narrate plans you won't execute. Don't summarize what the user can read in the diff.
