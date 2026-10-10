---
description: Size a task and, if large, write an approvable plan into .wiki/plans/
argument-hint: <what to build or change>
---
Task: $ARGUMENTS
1. Apply the `route` skill and state the size in one line.
2. S → say so and stop; the user can just ask for it. M → give a ≤10-bullet plan inline.
3. L → use the `planner` agent (plan skill) to write `.wiki/plans/YYYY-MM-DD-<slug>.md`.
Then stop and ask for approval. Do not write product code.
