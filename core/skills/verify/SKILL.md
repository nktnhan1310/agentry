---
name: verify
description: Evidence check before claiming work is done, fixed, or passing. Use before any completion message, commit, or PR.
---
# Verify
A claim needs fresh evidence from this session.
1. Run build/typecheck, lint, and the tests covering the change (commands from AGENTS.md).
2. Read the output, not just the exit code. Quote the pass/fail summary line.
3. Check the diff: `git diff --stat`, then scan for debug prints, commented-out code, stray TODOs, secrets, and unrelated files.
4. Check against the request or plan acceptance criteria. List any point not met.

Report (≤8 lines):
~~~
Verified: build ✓ · lint ✓ · tests 42/42 ✓ (`<command>`)
Not verified: <what and why, e.g. no e2e environment>
Unmet: <acceptance points not met, or "none">
~~~
Never write "should work", "probably fixed", or "done" without this block. If a check can't run, say so; don't skip it silently.
