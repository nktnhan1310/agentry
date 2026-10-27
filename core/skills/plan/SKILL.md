---
name: plan
description: Write an executable implementation plan into .wiki/plans/. Use for L-sized work (new feature, schema/API change, unclear design) before writing code.
---
# Plan
1. **Clarify.** If the goal, scope, or acceptance is ambiguous, ask ≤3 targeted questions, each with your recommended answer. Otherwise proceed.
2. **Recon.** Read `.wiki/index.md` and the relevant pages. Use `explorer` to find existing patterns, helpers, and tests to reuse. Note them by path.
3. **Design.** Choose the simplest approach. Record one rejected alternative and why, in one line.
4. **Write** `.wiki/plans/YYYY-MM-DD-<slug>.md` from the template. Each task must be executable with no chat context, because another model may run it.
5. **Approve.** Ask the user to approve, then hand off to `execute`.

~~~markdown
# <Title>
Goal: <1–2 lines> · Status: draft
Non-goals: <what we will not do>
Design: <≤8 lines: key decision, data flow, rejected alternative>
Risks: <data loss | migration | security | perf | none> → <mitigation>
Reuse: <existing helpers/patterns by path>

## Tasks
- [ ] T1 <imperative title> · size S|M{{#delegate}} · delegable yes|no{{/delegate}}
  Files: <paths to create/modify>
  Change: <precise steps: signatures, behaviour, edge cases; no full code>
  Verify: `<command>` → <expected result>
~~~

Rules
- Tasks take 2–15 minutes each and are ordered so every task leaves the build green.
- Tests belong to the task that changes behaviour, never to a final "add tests" task.
{{#delegate}}- `delegable yes` only when Files + Change + Verify are unambiguous and the task is not security-sensitive.
{{/delegate}}- Put the riskiest assumption in an early task so it fails fast.
- Keep the plan ≤150 lines. If it's bigger, split it into phases with separate plan files.
- Add one line to `.wiki/log.md`: `YYYY-MM-DD | plan | <title> | plans/<file>`.
