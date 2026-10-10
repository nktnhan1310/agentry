---
description: Code review + security audit of the current changes, merged into one report
argument-hint: [base ref | path] (default: uncommitted changes, else HEAD~1)
---
Scope: $ARGUMENTS (empty → `git diff HEAD`; if clean, `git diff HEAD~1`).
Run the `reviewer` and `security` agents in parallel on that scope.
Merge their findings: dedupe, sort by severity, keep `path:line` anchors. ≤30 lines total.
End with a verdict line: SHIP / FIX FIRST (n blocking).
