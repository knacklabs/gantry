# Settled job permission cards disappear like chat prompts

## What changes for you

In scope: the shared card projection (retire outcome + receipt text), the durability record (deleted/receipt state for idempotent retries), the durable-send wiring, and the four provider deliveries of a retire revision (Telegram, Slack, Discord delete; Teams receipt card). Non-goals: chat prompts (unchanged), card behaviour while rows are open, the once-expiry rule (JOBPERM-2), rule persistence, any UI beyond the retire step.

## Why

An approved chat permission prompt goes away: Telegram, Discord and Slack delete the message (`telegram/permission-prompt-settlement.ts:82`, `discord/permission-prompt-settlement.ts`, `slack/channel-interactions.ts` `delete_original`), falling back to a receipt edit only if the delete fails; Teams, whose bot messages cannot be deleted, edits the prompt to a receipt card (`teams/interaction-handlers.ts:440–470`). The job permission card (JOBPERM-1/2) never does: when its last row is answered the projection emits a `retire` revision with no outcome (`application/interactions/job-permission-card-projection.ts:155`) and the shared text is the static "All permission requests for this job are settled." (`domain/job-permission-card-actions.ts:70`); every provider edits the card to that line and it stays in the group. Owner feedback 2026-08-28: "these one-time permission messages stick around; they should disappear like in chat." Amended 2026-08-28 after signal S-0041: a denied row stays live per decision 0144, so retire outcomes are `allowed | expired`.

## Done when

1. AC1: when every row of a job permission card is settled by Allow, the card message is deleted on Telegram, Discord and Slack and edited to a one-line approved receipt on Teams; a failed delete falls back to the receipt edit.
2. AC2: when the remaining rows of a card have expired (the run ended before a decision), the card is edited to one line per expired request ('Expired: <command>') on every provider — never deleted; a card containing a denied row keeps its live rows (decision 0144: a Deny stays available with one-tap Reconsider) and does not retire.
3. AC3: the retire outcome (allowed | expired) is carried on the card revision by the shared projection; provider deliveries act on it; retry of a retire revision is idempotent.
4. AC4: existing unit and Postgres integration suites pass (only new or updated assertions on the retire text/operation); tsc, architecture check green.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Retire outcome on the card revision + Telegram delete/receipt | The card projection marks a retire revision allowed/expired (expired rows carried; denied rows never retire per 0144); shared text renders per-row 'Expired: <label>' lines; the durable-send wiring delivers an allowed retire as a delete of the provider message (receipt fallback) and an expired retire as an edit; Telegram deletes (editMessageText receipt on failure); deletedAt/receiptMessageId recorded on the revision so retries no-op. Unit + Postgres coverage. | 1, 2, 3, 4 | `apps/core/src/application/interactions/`, `apps/core/src/domain/job-permission-card-actions.ts`, `apps/core/src/domain/ports/job-permission-durability.ts`, `apps/core/src/domain/types.ts`, `apps/core/src/app/bootstrap/job-permission-wiring-setup.ts`, `apps/core/src/channels/telegram/`, `apps/core/src/domain/messages/retry-tail-provider-payload.ts`, `apps/core/test/unit/application/`, `apps/core/test/unit/channels/`, `apps/core/test/unit/domain/`, `apps/core/test/integration/`, `apps/core/src/adapters/storage/postgres/repositories/job-permission-need-repository.postgres.ts`, `apps/core/test/unit/adapters/`, `docs/specs/settled-job-permission-cards-vanish.md` | `apps/core/test/unit/application/jobperm-durability.test.ts` | none | no |
| T2 | Slack + Discord delete and Teams receipt card for retired cards | Slack and Discord delete a fully allowed retired card (fallback edit); Teams edits to an approved receipt card (or sends the receipt if no activity id); denied/expired retire stays a receipt edit; provider unit coverage. | 4 | `apps/core/src/channels/slack/`, `apps/core/src/channels/discord/`, `apps/core/src/channels/teams/`, `apps/core/src/channels/job-permission-card-settlement.ts`, `apps/core/src/channels/telegram/job-permission-card-delivery.ts`, `apps/core/src/domain/types.ts`, `apps/core/test/unit/channels/` | `apps/core/test/unit/channels/slack.test.ts`, `apps/core/test/unit/channels/discord/discord.test.ts`, `apps/core/test/unit/channels/teams/teams.test.ts` | T1 | no |

New moving parts: none named in the old plan

## Risks

- A delete racing an in-flight edit of the same message: keep the per-message lane serialization the Telegram card delivery already uses (`deliveries.serialize`).
- Recovery after a restart must not delete twice or re-send a receipt: `deletedAt`/`receiptMessageId` on the revision gate the retry.
- Teams cannot delete: receipt card is the ceiling; must not throw when no activity id is recorded (fall back to a plain receipt message).
- Expired wording must come from the need state (`expiredAt`), never from card text parsing; a denied need must never be treated as retired (0144 Reconsider).

## Notes

Converted from plans/active/JOBPERM-3-settled-job-permission-cards-disappear-like-chat-prompts.md by forge migrate.

### Technical Approach

- Projection: when the revision operation is `retire`, compute `retireOutcome: 'allowed' | 'expired'` from the settled needs (`cancelled`+`expiredAt` ⇒ `expired`; denied needs never reach retire because `livingCardNeeds` keeps them live per 0144) and carry the expired rows on the revision (`JobPermissionCardRevision` in `domain/ports/job-permission-durability.ts`, JSONB record — no migration, A-0065). `jobPermissionCardText` renders: `allowed` ⇒ the approved receipt line (used only where a delete is impossible or fails); `expired` ⇒ one line per row: "Expired: <label>". Card actions stay empty for retire.
- Wiring (`app/bootstrap/job-permission-wiring-setup.ts` ~`:315`): a retire revision with `retireOutcome === 'allowed'` is delivered as a **delete** of `providerMessageId` (new `MessageSendOptions.deleteMessageId`, `domain/types.ts:545` area) with the receipt text as fallback; `expired` stays an edit (`replaceMessageId`) with the receipt text.
- Providers: Telegram (`channels/telegram/job-permission-card-delivery.ts` + `channel-delivery.ts`) — `deleteMessage`, fallback `editMessageText` receipt; Slack (`channels/slack/channel-delivery.ts:104` edit path) — `chat.delete`, fallback `chat.update`; Discord (`channels/discord/index.ts:184` edit path) — `messageMutations.delete`, fallback edit; Teams — no delete: reuse the chat receipt card (`buildTeamsMessageCard` + `updateActivity`, as `teams/interaction-handlers.ts:451` does) or send the receipt if no activity id is recorded.
- Idempotency (AC3): the durability record marks the retire revision `deletedAt` (or `receiptMessageId`) the way settled message ids are recorded today (`deliveries.settledMessageId`, `telegram/job-permission-card-delivery.ts:53`); a retried retire revision no-ops when either is set. The reconciler's delivery log gains `operation: 'delete'` in the existing 'Job permission card delivered' line.

### Decisions

No new decision record: this reverses one JOBPERM-1 copy choice (the static "settled" line) to match the chat-prompt behaviour already decided per provider; 0124 (bounded durable card delivery) and 0144 hold. Kind = feature.

### Surface Impact

Group chats: an answered job card vanishes (Telegram/Discord/Slack) or becomes a one-line approved receipt (Teams); an expired card becomes per-row 'Expired:' lines; a card with a Deny stays as today (Reconsider). No CLI/config/schema change.

### Task Decomposition

- JOBPERM-3-T1: shared projection + record + wiring + Telegram delete (the owner's channel), with the receipt text and idempotent retry; unit + Postgres coverage. Contract: AC1 (Telegram part), AC2, AC3, AC4.
- JOBPERM-3-T2: Slack + Discord delete and Teams receipt card on the same revision shape; provider unit coverage. Contract: AC1 (remaining providers), AC4.

### Verify Plan

- `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/application/jobperm-*.test.ts apps/core/test/unit/channels/` green (only retire-text/operation assertions updated); full unit lane; `npx tsc --noEmit`; `npm run check:architecture`; Postgres lane `GANTRY_TEST_DATABASE_URL=… npm run test:integration:postgres`; `python3 factory/scripts/verify.py`.
- Live: deploy the branch, trigger KnackLabs, answer a "this run only" row with Allow → the card message disappears from the Telegram group; an untapped once row on a later run → the card becomes an 'Expired: …' line and stays.

### Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-28: AC2 'denied or expired' is read as EXPIRED only: per decision 0144 an explicit Deny stays a live card row with one-tap Reconsider, so a card containing a denied row never retires; a card retires only when every row is allowed (deleted on Telegram/Discord/Slack, receipt card on Teams) or when its remaining rows expired (edited to 'Expired: <command>' lines, never deleted) — owner ruling 2026-08-28.
