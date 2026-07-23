---
name: merge-gate-discipline
description: "Never chain `gh pr merge` unconditionally after a CI watcher — gate on the literal green verdict first (a red"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b85492d2-68c7-4c55-a5a3-551ccd75b3a1
---

2026-07-21: a CI watcher printed "PR250 CI VERDICT: red" but the same Bash
command chained `gh pr merge 250` unconditionally, merging a red PR onto main
(multi-account regression; required an immediate revert).

**Why:** the merge-on-green policy is enforced by ME, not by the repo (no
required checks — `--auto` merges instantly, memory
[[scheduler-mock-fixed-exports]]).

**How to apply:** read the watcher verdict in one step; merge in a SEPARATE
step only after literally seeing `green`. Never `cat verdict; gh pr merge ...`
in one chained command. Also: a "fix verified by focused tests" is not
verified — run the full affected LANE (the #250 bug was visible only in the
full postgres integration lane). Related: [[e2e-required-for-merges]].
