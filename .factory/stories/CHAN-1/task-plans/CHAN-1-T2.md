# CHAN-1-T2 — Teams adapter moves to channels/teams/

Contract: pure layout move, no behaviour change. Every `apps/core/src/channels/teams-*.ts` (22 files) becomes `apps/core/src/channels/teams/<name>.ts` with the `teams-` prefix dropped; `teams.ts` becomes `teams/index.ts`. Teams unit tests move to `apps/core/test/unit/channels/teams/`.

Steps:
1. `git mv` each file (renames, not delete+add). Name map: `teams-<x>.ts` → `teams/<x>.ts`; `teams.ts` → `teams/index.ts`.
2. Inside the folder, rewrite relative imports: `./teams-<x>.js` → `./<x>.js`; `./teams.js` → `./index.js`; channels-root modules `./<shared>.js` → `../<shared>.js`; deeper parents gain one extra `../`.
3. Elsewhere in `apps/core/src` (14 importers): `channels/teams-<x>.js` → `channels/teams/<x>.js`; `channels/teams.js` → `channels/teams/index.js`.
4. Tests: move the Teams test files under `apps/core/test/unit/channels/teams/`, rewrite imports and any `vi.mock('<path>')` string paths.
5. Architecture map (`scripts/architecture-map.json`) / path-keyed config: re-point every entry that names an old path; none dropped.
6. Verify: zero-hit grep for `channels/teams-` and `'./teams-`; `npx tsc --noEmit`; `npm run check:architecture`; Teams unit tests from the new folder; full unit lane; Postgres integration lane (story-level AC3 closes here).

Not in scope: symbol renames, splitting modules, Discord (done in T1), Slack/Telegram, any logic change.
