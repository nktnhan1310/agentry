---
description: Implement an approved plan (or a clear task) with verification
argument-hint: <plan path [task ids] | task description>
---
Input: $ARGUMENTS
- Plan path → follow the `execute` skill (delegable tasks → `delegate` agent; others → `implementer` agent).
- Plain task → apply the `route` skill first, then implement at that size.
Finish with the `verify` skill report. Do not commit unless asked.
