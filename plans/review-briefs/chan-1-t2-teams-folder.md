# Review brief — CHAN-1-T2 (Teams adapter moves to channels/teams/)

Contract: pure layout move. Every `apps/core/src/channels/teams-*.ts` (22 files) is now `apps/core/src/channels/teams/<name>.ts` with the prefix dropped; `teams.ts` is `teams/index.ts`. Teams unit tests moved under `apps/core/test/unit/channels/teams/`. Imports rewritten (in-folder relative paths, 14 external importers, tests, `scripts/architecture-map.json`, doc path references that `check:architecture` validates). This closes story AC2/AC3 (Discord landed in T1).

BY DESIGN: no exported symbol renamed, no module split/merged, no logic change; Slack/Telegram untouched. Historical audit documents may have path citations re-pointed only where `check:architecture` validates them.

Focus: every rename is a rename (git diff -M), every import resolves, no dropped architecture-map entry, no content change inside moved files. Report ONLY behaviour or resolution defects. Ignore style.

Review: autoreview flagged `../permission-approval-result-helpers.js` in the moved teams.test.ts as unresolvable — REJECTED on evidence: the helper is apps/core/test/unit/channels/permission-approval-result-helpers.ts, so `../` from channels/teams/ resolves; the worker rewrote that import (diff shows the new line) and the Teams suite passes (2 files / 59 tests); full unit lane 679/9050.
