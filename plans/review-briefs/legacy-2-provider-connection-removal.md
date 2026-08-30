# Review brief — LEGACY-2 (remove the providerConnection dual-read)

Facts: provider connections became provider accounts on 2026-07-02; the old `providerConnection` name survived as an in-memory shadow field (types + parser fill) read at ~20 sites as `providerAccount ?? providerConnection`. 19 time-boxed architecture exceptions (kind dual_read) expired 2026-08-28. Owner ruling: remove now, no extension.

Contract for this diff (NO behaviour change):
- AC1: shadow field and parser fill deleted; every `providerAccount ?? providerConnection` collapses to `providerAccount`; writers stop creating the property; rename-only locals lose the token.
- AC2: a settings document carrying `provider_connection` keeps being rejected by the EXISTING strict key check — the diff must add no silent-drop or mapping code.
- AC3: exactly the 19 `symbol: providerConnection` entries are removed from scripts/architecture-exceptions.json; every other entry untouched; check:architecture passes.
- AC4: suites pass with only shadow-field assertions changed; tsc green.

Focus: (1) a read that silently widened or narrowed — the Slack approver lookup must stay account-qualified (`conversation.providerAccount === providerAccountId`); (2) any leftover site where `providerConnection` was the ONLY source (would now be undefined) — should be none because the parser always filled it from providerAccount; (3) out-of-scope drift: `providerConnectionId` (routes/events/CLI) and the OpenAPI enum `missing_provider_connection` must be untouched (deferral D-0070); (4) tests: no test weakened, the two new leaves exist. Ignore style.
