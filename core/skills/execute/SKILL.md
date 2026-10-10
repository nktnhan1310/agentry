---
name: execute
description: Execute an approved plan from .wiki/plans/ task by task, routing each task to the cheapest executor, with verification. Use after plan approval or "implement the plan".
---
# Execute
Set the plan `Status: in progress`. For each unchecked task, in order:
1. **Pick an executor**
   - S-sized and quick → do it inline.
   - `delegable yes` → `delegate` agent (opencode; saves Claude tokens).
   - Otherwise → `implementer` agent. Pass the plan path + task id, not the plan text.
   - Tasks with disjoint Files and no ordering dependency may run in parallel.
2. **Verify yourself.** Run the task's Verify command. Never trust a worker's "done".
3. **On failure**, give one fix attempt with the error excerpt (≤20 lines). Still failing → stop, report, and ask.
4. **Tick it** in the plan (`- [x] T3`). If reality diverged from the plan, edit the plan's Change line so it stays true.

After the last task
- Run the `verify` skill on the whole change.
- Run `reviewer`, plus `security` if Risks mention security, auth, data, or migrations. Fix BLOCKING findings.
- Set `Status: done`, append to `.wiki/log.md`, and update wiki pages for any new non-obvious decisions (wiki skill).

Context hygiene
- Read diffs as `git diff --stat` first, then only the hunks you need (`git diff -- <path>`).
- Keep worker reports; don't re-open the files they changed unless verification fails.
