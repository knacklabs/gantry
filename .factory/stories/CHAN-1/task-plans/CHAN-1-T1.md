# CHAN-1-T1 — Discord adapter moves to channels/discord/

Contract: pure layout move, no behaviour change. Every `apps/core/src/channels/discord-*.ts` (34 files) becomes `apps/core/src/channels/discord/<name>.ts` with the `discord-` prefix dropped; `discord.ts` becomes `discord/index.ts`. Discord unit tests move to `apps/core/test/unit/channels/discord/`.

Steps:
1. `git mv` each file (keep history: renames, not delete+add). Name map: `discord-<x>.ts` → `discord/<x>.ts`; `discord.ts` → `discord/index.ts`.
2. Inside the folder, rewrite relative imports: `./discord-<x>.js` → `./<x>.js`; `./discord.js` → `./index.js`; any `./<shared>.js` (a channels-root module such as `./interaction-settlement.js`, `./channel-shared.js`) → `../<shared>.js`; deeper parents gain one extra `../`.
3. Elsewhere in `apps/core/src` (13 importers): `channels/discord-<x>.js` → `channels/discord/<x>.js`; `channels/discord.js` → `channels/discord/index.js`.
4. Tests: move the Discord test files under `apps/core/test/unit/channels/discord/`, rewrite their imports and any `vi.mock('<path>')` string paths.
5. Architecture budgets / path-keyed config: re-point every entry that names an old path; none dropped.
6. Verify: zero-hit grep for `channels/discord-` and `'./discord-`; `npx tsc --noEmit`; `npm run check:architecture`; Discord unit tests from the new folder; full unit lane.

Not in scope: symbol renames, splitting modules, Teams (T2), Slack/Telegram, any logic change.
