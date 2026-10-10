---
name: debug
description: Root-cause debugging for bugs, failing tests, or unexpected behaviour. Use before attempting any fix whose cause is not already proven.
---
# Debug
No fix before a proven cause. Guess-and-check burns tokens and hides the real bug.
1. **Reproduce.** Get a deterministic repro (a failing test or command). Capture the exact error and the top ~30 lines of the stack.
2. **Localize.** Read only the implicated ranges from the stack. If it used to work, run `git log --oneline -n 10 -- <file>` or `git log -S "<symbol>" -n 5`, or `git bisect run <cmd>`.
3. **Hypothesize.** Write ONE hypothesis and the evidence it predicts. Test it with the cheapest probe: a log line, an assertion, a narrower test, or a REPL.
4. **Confirm → fix.** Write a regression test (`tdd`), apply the minimal fix, check the repro passes, then run neighbouring tests.
5. **Escalate.** After 3 disproven hypotheses, stop. Summarize the evidence and ask, or question the design (it may not be a local bug).

Rules
- Change one thing at a time; revert probes afterwards.
- Never "fix" symptoms: no swallowed errors, widened catches, added retries or sleeps, skipped tests, or loosened types.
- Check the environment early: versions, env vars, stale builds/caches, wrong working directory.
- Non-obvious root cause → one entry in `.wiki/gotchas.md`: **symptom** → cause → fix (`path:line`).
