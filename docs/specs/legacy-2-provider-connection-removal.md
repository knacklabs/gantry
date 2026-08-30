---
slug: legacy-2-provider-connection-removal
title: LEGACY-2 — Remove the providerConnection dual-read
status: confirmed
saved: 2026-08-29T03:33:16+00:00
---

---
slug: legacy-2-provider-connection-removal
title: LEGACY-2 — Remove the providerConnection dual-read
status: confirmed
saved: 2026-08-29T03:16:31+00:00
---

# LEGACY-2 — Remove the providerConnection dual-read

Story: LEGACY-2
Inputs: 19 time-boxed architecture exceptions (`scripts/architecture-exceptions.json`, symbol `providerConnection`, kind `dual_read`, introduced 2026-08-07 by LEGACY-1's follow-up, `remove_by: 2026-08-28`) expired on 2026-08-28, so `npm run check:architecture` fails on main and every branch. Owner ruling 2026-08-29: remove the dual-read now, before JOBPERM-3 ships — not an extension.

## Why

"Provider connections" became "provider accounts" on 2026-07-02. To avoid a big-bang edit, the old `providerConnection` name was kept as a shadow field: the settings parser still fills it from `providerAccount`, the types still declare it, and about 35 sites read `providerAccount ?? providerConnection`. Decision 0003 says the runtime carries no internal back-compat; the exceptions were the timer that enforces it, and the timer went off. One name, one read path.

## Locked product decisions (Ravi, in chat 2026-08-29)

1. A settings document (settings.yaml or a stored settings revision) that still carries `provider_connection` / `providerConnection` keeps being **rejected by the existing strict key check** (`runtime-settings-compact.ts:150`, `runtime-settings-parser.ts:187`) — no new code, no silent drop. The dual-read only ever existed in memory (the parser-filled shadow field); that is what LEGACY-2 removes.
3. `providerConnectionId` (route/event payloads, CLI setup return names) and the OpenAPI enum `missing_provider_connection` are OUT of scope: not part of the expired gate; renaming them is a wider, externally visible change (deferral).
2. One PR off main, merged before JOBPERM-3; no extension of the exception dates.

## Behaviour

- The runtime settings types no longer declare `providerConnection`; the parser no longer fills it; no reader consults it. Every `providerAccount ?? providerConnection` collapses to `providerAccount`.
- Control routes and CLI helpers that used `providerConnection` as a local name for a provider-account lookup are renamed; behaviour unchanged.
- The Slack permission-approval delivery and the control-plane storage model read provider accounts only.
- Desired-state export and revision serialisation already write `provider_account` only; that stays.
- `scripts/architecture-exceptions.json` has no `providerConnection` entries left.

## Acceptance criteria

- AC1: the providerConnection shadow field is removed from the runtime settings types and the parser no longer fills it; every `providerAccount ?? providerConnection` read collapses to providerAccount (settings parser/validation/renderer/exports/reconcile/observer activation, control-plane storage model, CLI provider utils, Slack permission delivery, control routes).
- AC2: a settings document that still carries providerConnection / provider_connection keeps being rejected by the existing strict key check (no new code); nothing dual-reads it in memory.
- AC3: the 19 providerConnection entries are deleted from scripts/architecture-exceptions.json and `npm run check:architecture` passes with no providerConnection exception.
- AC4: existing unit and Postgres integration suites pass (only assertions that named providerConnection change); tsc green.

## Not in scope

The conversation-JID dual-read (named "LEGACY-2" in the LEGACY-1 spec's prose) — a Phase-8 history migration, tracked separately. `providerConnectionId` and `missing_provider_connection` (see locked decision 3).
