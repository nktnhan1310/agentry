---
description: Root-cause and fix a bug or failing test
argument-hint: <symptom, error, or failing test>
---
Bug: $ARGUMENTS
Follow the `debug` skill: reproduce → localize → one hypothesis at a time → prove the cause → regression test (`tdd`) → fix.
Finish with the `verify` skill report and add a `.wiki/gotchas.md` entry if the cause was non-obvious.
