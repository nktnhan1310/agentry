---
name: tdd
description: Red-green-refactor loop for behaviour changes and bug fixes. Use when adding behaviour, fixing a bug, or when a task's Verify step needs a new test.
---
# TDD
1. **Red.** Write the smallest test that expresses the new behaviour or reproduces the bug. Run it and confirm it fails *for the right reason* (an assertion, not an import or typo error).
2. **Green.** Make the minimal production change that passes. Run that test, then its neighbours (same file/module).
3. **Refactor** only if duplication or clarity demands it. Tests stay green.

Rules
- Bug fix = failing regression test first, named after the broken behaviour.
- Assert on outputs and observable effects, not on internal calls.
- Mock only at boundaries: HTTP, clock, randomness, external services. Prefer real in-memory/test DBs over mocking the ORM.
- Iterate with the narrowest test command; run the full suite once at the end.
- Skip TDD (and say so) for pure config, copy text, styling, generated code, or throwaway spikes.

Narrow test commands
- Vitest: `npx vitest run <file> -t "<name>"` · Jest: `npx jest <file> -t "<name>"`
- Playwright: `npx playwright test <file> -g "<name>"`
- .NET: `dotnet test --filter "FullyQualifiedName~<Name>"`
- Python: `pytest <file>::<test> -q` (prefix `uv run` / `poetry run` per AGENTS.md)
