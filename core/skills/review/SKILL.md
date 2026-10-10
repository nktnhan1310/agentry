---
name: review
description: Review a diff for correctness, contracts, tests, design, and risk with severity-ranked findings. Use after implementation or when asked to review code, a branch, or a PR.
---
# Review
Scope: the diff (`git diff <base>...HEAD`, or the working tree) plus the direct callers of changed symbols. Not the whole repo.

Passes, in order (once you have BLOCKING items, finish the pass and stop deepening):
1. **Correctness.** Logic, off-by-one, null/undefined, async/await misuse, races, swallowed errors, edge cases (empty, max, unicode, timezone).
2. **Contracts.** Breaking API/schema/event changes, reversible migrations, serialization, backward compatibility, config defaults.
3. **Security quick pass.** Input validation, authz on new endpoints/actions, injection, secrets, PII in logs. A deep audit is `security-audit`.
4. **Tests.** Would a test fail if this change were reverted? Missing edge/error cases for changed behaviour.
5. **Design.** Duplicates an existing helper, wrong layer, needless abstraction, misleading names, dead code.
6. **Performance.** N+1 queries, unbounded lists/loops, sync I/O on hot paths, missing index for a new filter, re-render storms.

Severity
- **BLOCKING:** bug, security hole, data loss, breaking change.
- **SHOULD:** likely future bug, missing test for changed behaviour, clear design problem.
- **NIT:** optional; at most 3, and none if there are BLOCKING items.

Each finding: `path:line` — problem — concrete failure scenario — fix in ≤2 lines.
Skip anything linters or formatters catch. No praise, no restating the diff.
Nothing found → `LGTM` + one line on what you checked.
