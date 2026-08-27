# Review brief — CHAN-1-T1 (Discord adapter moves to channels/discord/)

Contract: pure layout move. Every `apps/core/src/channels/discord-*.ts` (34 files) is now `apps/core/src/channels/discord/<name>.ts` with the prefix dropped; `discord.ts` is `discord/index.ts`. Discord unit tests moved under `apps/core/test/unit/channels/discord/`. Imports rewritten (in-folder relative paths, 13 external importers, tests, `scripts/architecture-map.json`, doc path references that `check:architecture` validates).

BY DESIGN: no exported symbol is renamed, no module split/merged, no logic change; Teams is untouched (CHAN-1-T2). Historical audit documents keep their original `discord-*.ts` citations (dated line ranges); `check:architecture` passes.

Focus: every rename is a rename (git diff -M ≥ 90%), every import resolves, no dropped architecture-map entry, no accidental content change inside moved files. Report ONLY behaviour or resolution defects. Ignore style.
