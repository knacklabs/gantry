# Remove the providerConnection dual-read

## What changes for you

- Delete the shadow field declaration and the parser fill; delete the two secondary optional shadows (`control-plane-storage-model.ts:141`, `cli/provider-utils.ts:114`).
- Collapse every `providerAccount ?? providerConnection` read to `providerAccount`: Slack `permission-approval-delivery.ts:122`, `control-plane-storage-model.ts:191`, `provider-utils.ts:140`, `runtime-settings-binding-derivation.ts:29/44`, `conversation-install-settings.ts:123`, `settings-revision-document.ts:51`, `runtime-settings-renderer.ts:436`, `runtime-settings-validation.ts:190/194/219`, `desired-state-export-helpers.ts:182`, `desired-state-provider-conversations.ts:103`, `desired-state-service-helpers.ts:169/187/227/365`, `desired-state-conversation-reconcile.ts:103`, `observer-activation.ts:86`.
- Stop creating the shadow property in writers: `conversation-install-settings.ts:67`, `runtime-settings.ts:406`, `desired-state-current-export.ts:248/515`, `desired-state-conversation-reconcile.ts:204/283`; drop the strip in `config/index.ts:163`.
- Rename the rename-only locals/helper names that carry the exact token (`routes/agents.ts:638-659`, `desired-state-export-helpers.ts:126/135/175`, `desired-state-service-helpers.ts:486`, `runtime-settings.ts:344/361/484`) to `providerAccount…`; no behaviour change.
- Delete the 19 `providerConnection` entries from `scripts/architecture-exceptions.json`.
- Tests: update the 74 test/fixture mentions only where they assert or construct the shadow field; assertions on `provider_account` stay.

**Non-goals**

- The old document key `provider_connection` keeps being rejected by the existing strict key check (`runtime-settings-compact.ts:150`, `runtime-settings-parser.ts:187`) — no silent drop, no new code (locked decision 1).
- `providerConnectionId` (ConversationRoute, identity-event payloads, CLI setup return names in `cli/slack.ts`, `discord.ts`, `teams.ts`, `telegram-connect.ts`, `group-helpers.ts`) and the OpenAPI enum `missing_provider_connection` stay untouched (locked decision 3; deferral).
- The conversation-JID dual-read (LEGACY-1's "LEGACY-2" prose item) — separate Phase-8 migration.
- No data migration: migration 0092 already rewrote `provider_connection` → `provider_account`; serialisers already emit only `provider_account`.

## Why

When provider connections became provider accounts (2026-07-02), the old `providerConnection` name survived as an in-memory shadow field: `runtime-settings-types.ts:40` declares it, `runtime-settings-parser.ts:241` fills it from `providerAccount`, and about twenty sites read `providerAccount ?? providerConnection`. Decision 0003 says the runtime carries no internal back-compat, so LEGACY-1 fenced this with 19 time-boxed architecture exceptions (`scripts/architecture-exceptions.json`, symbol `providerConnection`, kind `dual_read`, `remove_by 2026-08-28`). They expired: `npm run check:architecture` is red on main and on every branch, and JOBPERM-3 cannot close its stage. Owner ruling (2026-08-29): remove the dual-read now, before JOBPERM-3 ships.

## Done when

1. AC1: the providerConnection shadow field is removed from the runtime settings types and the parser no longer fills it; every `providerAccount ?? providerConnection` read collapses to providerAccount (settings parser/validation/renderer/exports/reconcile/observer activation, control-plane storage model, CLI provider utils, Slack permission delivery, control routes).
2. AC2: a settings document that still carries providerConnection / provider_connection keeps being rejected by the existing strict key check (no new code); nothing dual-reads it in memory.
3. AC3: the 19 providerConnection entries are deleted from scripts/architecture-exceptions.json and `npm run check:architecture` passes with no providerConnection exception.
4. AC4: existing unit and Postgres integration suites pass (only assertions that named providerConnection change); tsc green.

## Tasks

| ID | Name | What it delivers | Covers | Scope | Tests | After | User-facing |
|---|---|---|---|---|---|---|---|
| T1 | Remove the providerConnection shadow field, dual-reads and the 19 expired exceptions | Delete the in-memory providerConnection shadow field (types + parser fill), collapse every providerAccount ?? providerConnection read to providerAccount, stop writers creating the shadow property, rename the rename-only locals, delete the 19 exception entries, update the tests that named the shadow; old document key stays rejected by the existing strict check. | 2, 4 | `apps/core/src/config/`, `apps/core/src/application/control-plane/control-plane-storage-model.ts`, `apps/core/src/cli/provider-utils.ts`, `apps/core/src/channels/slack/permission-approval-delivery.ts`, `apps/core/src/control/server/routes/agents.ts`, `scripts/architecture-exceptions.json`, `apps/core/test/` | `apps/core/test/unit/config/runtime-settings.test.ts` | none | no |

New moving parts: none named in the old plan

## Risks

- A missed `?? providerConnection` site compiles only if the property still exists — deleting the type first makes tsc the safety net.
- Slack approver lookup: the expression becomes `conversation.providerAccount === providerAccountId`; keep account-qualified matching (no widening).
- `settings_revisions` rows that carry only the old key would already fail today; migration 0092 covered them — a read-only live-DB inventory is a closeout check, not a code change.
- Review budget: ~20 source files + tests; refactor ratchet applies (kind refactor).

## Notes

Converted from plans/active/LEGACY-2-remove-the-providerconnection-dual-read.md by forge migrate.

### Technical Approach

Mechanical single-cut removal, one bounded task. Order: types + parser first (tsc then lists every dependent site), collapse the reads, remove the writers' shadow property, rename the locals, delete the exception entries, fix the tests that referenced the shadow. The guard matches the exact token with word boundaries (`scripts/architecture_rules.py:41/48`), so `providerConnectionId` does not trip it and needs no change. No new helpers, no compat shims.

### Decisions

- 0003 (no internal back-compat) — this is its enforcement; no new decision needed.
- 0007 / 0025 (settings as runtime truth, settings authority) — unchanged; `provider_account` remains the sole source.
- 0009 (canonical schema cutover) — consistent.
- Deferral to record: rename of `providerConnectionId` + `missing_provider_connection` enum (external-facing).

### Surface Impact

Runtime settings parsing/validation/rendering (internal types only), control-plane storage model, control route `agents.ts` (local rename), CLI provider utils, Slack permission approver lookup, architecture exceptions file. No settings.yaml shape change, no contract/SDK change, no migration, no docs/prompt change.

### Task Decomposition

- LEGACY-2-T1: remove the shadow field, dual-reads, shadow writers and rename-only locals; delete the 19 exceptions; update the affected tests. Contract: AC1–AC4.

### Verify Plan

`npx tsc --noEmit`; `npm run check:architecture` (must pass with zero providerConnection exceptions); `npx vitest run -c vitest.unit.config.ts apps/core/test/unit/config/ apps/core/test/unit/channels/ apps/core/test/unit/cli/ apps/core/test/unit/application/ apps/core/test/unit/control/`; Postgres lane host-side (`npm run test:integration:postgres` subset touching settings revisions); `python3 factory/scripts/verify.py` at closeout; autoreview local with a brief stating "no behaviour change; old key still rejected". Closeout check (read-only, host-side): inventory `settings_revisions.settings_document_json` for any remaining `provider_connection` key — expected zero after migration 0092.
