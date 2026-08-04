---
decisions_reviewed:
  - 0000-credential-broker-boundary
  - 0001-agent-runtime-platform
  - 0002-symphony-forge-adoption
  - 0003-early-stage-no-backcompat
  - 0004-gantry-naming-and-public-repo
  - 0005-runtime-stack
  - 0006-config-secret-source-boundary
  - 0007-settings-runtime-truth
  - 0008-storage-backend-cutover
  - 0009-canonical-domain-schema-cutover
  - 0010-claude-runtime-materialization
  - 0011-provider-session-artifact-store
  - 0012-browser-capability-boundary
  - 0013-runtime-event-exchange
  - 0014-external-ingress-vs-outbound-webhooks
  - 0015-model-catalog-and-cache-accounting
  - 0016-event-bus-outbox-boundary
  - 0017-jsonb-runtime-payload-boundary
  - 0018-provider-neutral-agent-execution-adapter
  - 0019-simple-permission-and-job-tool-lifecycle
  - 0020-mcp-source-vs-action-capability
  - 0021-capability-artifacts
  - 0022-delivery-vehicle
  - 0023-deployment-modes
  - 0024-locked-preset
  - 0025-settings-authority
  - 0027-process-roles-and-multi-live
  - 0028-agent-harness-selection
  - 0029-agent-communication-reaction-binding
  - 0030-agent-communication-reasoning-safety
  - 0031-send-message-files-authority
  - 0032-signed-artifact-links-deferred
  - 0033-teams-reactions-deferred
  - 0034-client-signoff
  - 0035-epics-approved
  - 0040-permission-execution-two-axis-model
  - 0041-client-signoff
  - 0042-decision-view-16k-prefix-stripped
  - 0043-classifier-risk-only-engine-authz
  - 0044-ci-runner-isolation
  - 0045-inbound-attachment-descriptor-writer
  - 0046-llm-process-local-admission
  - 0050-agent-removal-projection-cleanup
  - 0051-client-signoff
  - 0052-birthright-self-surface
  - 0053-permission-no-timeout-interactive
  - 0054-decision-provenance-and-risk-label
  - 0055-client-signoff
  - 0056-durable-cancellation-invariant
  - 0057-arch1-client-signoff
  - 0058-readonly-scheduler-birthright
  - 0062-perm6-client-signoff
  - 0063-perm7-client-signoff
  - 0064-client-signoff
  - 0065-perm8-client-signoff
  - 0066-race-1-skill-artifact-app-isolation
  - 0067-client-signoff
  - 0068-race-2-cluster-fenced-settings-projection
  - 0069-client-signoff
  - 0070-client-signoff
  - 0071-race-4-browser-profile-lock-aba
  - 0072-client-signoff
  - 0073-race-6-profile-mirror-version-guard
  - 0074-race-8-mandatory-atomic-async-admission
  - 0075-race-9-serialize-file-backed-settings-write
  - 0076-client-signoff
  - 0077-race-5-lease-loss-lifecycle
  - 0078-lat-3a-single-memory-hydration-per-turn
  - 0079-client-signoff
  - 0080-lat-3b-retain-authoritative-second-fetch
  - 0081-client-signoff
  - 0082-fence-1-durable-lease-generation
  - 0083-conv-001-client-signoff
  - 0084-client-signoff
  - 0085-lat-4a-fused-inbound-envelope-transaction
  - 0086-client-signoff
  - 0087-lat-5-durable-provider-history-coverage
  - 0088-client-signoff
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
---

# LAT-5B — Durable Provider-History Coverage: Complete Conversations Stop Re-Requesting

Issue: `LAT-5B`
Branch: `perf/lat5b-durable-history-coverage`
Base: `origin/main` @ `1f6590b8f`
Program: MyClaw Response-Latency Refactor, Phase 5, second of the two signed-off PRs
Governing decision: `docs/decisions/0087-lat-5-durable-provider-history-coverage.md` (accepted)
Coverage protocol: `docs/decisions/0089-thread-turns-read-channel-context.md` (canonical aggregate protocol)
Sign-off: `docs/decisions/0088-client-signoff.md` (the two-PR split IS the signed-off shape)

## Problem

While a conversation's local window is incomplete, EVERY eligible turn awaits
the provider hydration hook under the 2.5s ceiling and pays per-message
persistence plus a context re-query. LAT-5A made adapters report honest
coverage; GH-352 made the completeness claim trustworthy (aggregate
protocol). But nothing DURABLE records it: `shouldHydrateConversationContext`
(`runtime/group-conversation-context.ts:184-194`) keys only off the local
window flags, so a conversation whose history the provider has confirmed
complete — yet whose local window is sparse (short genuine history) — hydrates
again on every turn, forever. The hydration result's `coverage` block is
currently read by NOTHING at the runtime seam.

## Scope / Non-goals

### In scope

1. **Table** (migration `0118`): `conversation_history_coverage` — keyed
   by the EXISTING `conversations.id` as an explicit FK (never recomputed
   from JID — noncanonical legacy ids can remain authoritative,
   `canonical-graph-repository.postgres.ts:268`; the route already carries
   `conversationId`, threaded through `group-processing.ts` and
   `group-processing-context.ts` which currently drop it) plus a
   collision-free scope pair (`scope_kind` in {channel, thread} +
   `scope_id` nullable thread id). Columns: `complete` (only ever true from
   a server_confirmed exhausted claim), `covered_through_external_id` +
   `covered_through_timestamp` (the requested-latest boundary from the
   coverage shape, `conversation-context-hydration.ts:37`),
   `provider_generation` bigint, `recorded_at`, `updated_at`; unique on
   (conversation_id, scope_kind, scope_id).
2. **Write path**: after a hydration's messages finish persisting
   (`group-conversation-context.ts:~100`, where `hydration.coverage` stays
   in lexical scope), record coverage. `complete = true` requires BOTH the
   server_confirmed exhausted claim AND **zero accepted-message persistence
   failures** — the persist loop catches per-message errors and continues
   (`:74-80`), and attesting completeness over a partially-stored window
   would poison coverage; any failure ⇒ write `complete = false`. Writes
   are generation-checked compare-and-swap upserts — no worker claims:
   attestations are idempotent; a stale writer's CAS no-ops.
3. **Read path — two-phase**: (1) build the local packet as today; (2) if
   the local completeness predicate already says complete, STOP — zero new
   statements; (3) only for an incomplete packet, one coverage/generation
   lookup decides whether to hydrate. `+1 statement on incomplete-window
   turns, +0 on complete ones` is a TARGET until the Postgres harness
   measures it (AC6). No DB call happens inside the synchronous
   `shouldHydrateConversationContext` — the guard becomes an async
   two-phase decision at its call site. `request_bounded` rows never
   satisfy the guard (promotion impossible by construction).
4. **Invalidation — the safety heart**: completeness is only trustworthy
   while live delivery has been gapless since it was recorded.
   - **Generation substrate**: the `runtime_lease_generations` TABLE (0116)
     is reused under the uncontested `history_coverage:<providerAccountId>`
     namespace, but through a NEW dedicated fail-closed `bump/read`
     repository surface — an atomic increment that cannot fail silently.
     The existing `RuntimeLeasePort.tryAcquire` is explicitly NOT the bump
     API (it advisory-locks, holds, and returns undefined on contention —
     unacceptable for mandatory invalidation, `runtime-store.ts:326-360`).
   - **Enumerated bump seams (per critique, file:line-verified)**:
     shared wiring bumps BEFORE the awaited inbound `channel.connect(...)`
     begins (events can arrive during the await —
     `provider-account-channel-connect.ts:97,101,231`), fanned out across
     EVERY `inboundProviderAccountId` sharing the transport; Discord bumps
     once inside `open()` immediately before WebSocket creation (covers
     initial connect, socket close, opcode 7, opcode 9 retries —
     `discord-gateway.ts:46-134`; no double-bump at generic wiring);
     **Slack requires a NEW receiver/client lifecycle signal** — Socket
     Mode reconnects after `app.start()` are library-owned and currently
     unobservable (`slack/channel-connect.ts:12-22`); the adapter exposes a
     reconnect callback wired to the bump. Teams: fake-adapter proof only
     until a production SDK client exists (stated, not claimed). Telegram:
     excluded (no hydration hook — no coverage rows to invalidate).
   - Coverage rows carry the generation they were recorded under; the read
     guard requires equality. A restart or reconnect silently un-trusts ALL
     completeness for the account until one fresh hydration re-attests —
     fail-safe, no sweeping.
   - **Live growth**: new live messages persist as they arrive, so
     completeness through the covered boundary survives naturally within
     one generation.
   - **Contradiction**: any later hydration whose aggregate claim is NOT
     exhausted overwrites `complete` to false (CAS on generation).
5. **Measurement**: extend the group-processing hydration assertions and add
   a real-Postgres integration proof: a conversation attested complete makes
   ZERO provider hydration calls and never enters the deadline wait; after a
   generation bump the same conversation hydrates exactly once and
   re-attests. Before/after statement counts recorded for the guard lookup.
6. `docs/architecture/messaging-hotpath-and-liveness-goal-prompt.md` premise
   table updated (5B row) — the corrected "ceiling not per-turn cost"
   framing from 0087 carried through.

### Non-goals

- No settings/knobs; no TTLs (generation equality is the only validity rule).
- No cross-provider semantics change: providers without hydration hooks
  (Telegram) never get coverage rows — nothing to skip.
- No touch of the 2.5s deadline value, window sizes, or the hydration
  request shape; no read of `coverage` beyond the completeness claim.
- Scheduled-job turns (D-0022) keep their current hydration behaviour; they
  simply benefit from the same guard.

## Acceptance Criteria

- **AC1 (schema)** — migration 0118 + journal + schema-sync test; unique
  (conversation, scope); rows round-trip through a dedicated repository.
- **AC2 (write honesty)** — after persisting a hydration with
  `server_confirmed exhausted:true`, the row shows complete=true at the
  current generation; a `request_bounded` or non-exhausted claim writes
  complete=false. Falsify: make the writer accept request_bounded as
  complete → the promotion test must fail.
- **AC3 (read guard)** — with a valid complete row: the provider hydrate
  hook is NEVER invoked (provider-call spy; the deadline helper is private
  — assert via the spy plus an injectable deadline seam if one is needed,
  never by spying private internals); with an incomplete window and NO row:
  hydrates exactly as today (byte-identical — regression against existing
  suites). Falsify: drop the generation-equality predicate → the
  stale-generation test must fail.
- **AC4 (invalidation)** — bumping the provider generation (simulated
  reconnect at the wiring seam) makes the next turn hydrate ONCE and
  re-attest at the new generation; a contradiction claim flips complete to
  false. Falsify: skip the wiring bump → the missed-gap test fails.
- **AC5 (concurrency)** — two concurrent attestation writers: CAS semantics,
  last-valid-generation wins, no row duplication (real-Postgres proof).
- **AC6 (measurement)** — the integration proof records provider-call counts
  and the guard's statement cost; the PR carries before/after numbers and an
  explicit what-did-not-improve statement.
- **AC7** — release gates green (full lanes, architecture, `verify.py`).

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Changed** | Complete conversations skip provider hydration + the deadline wait; reconnects un-trust coverage. |
| API | **Unchanged by design** | Internal repository + guard; no contracts. |
| Data / schema | **Changed** | Migration 0118: one new table; generation keys reuse the 0116 substrate. |
| CLI / ops | **Unchanged by design** | No commands or settings. |
| UI | **N-A** | No user-visible surface. |
| Docs | **Changed** | Goal-prompt premise row; decision 0087 already governs. |
| Tests | **Changed** | Repository round-trip, write-honesty falsifications, read-guard + invalidation proofs, concurrency CAS, measurement. |
| Deferred | **Deferred** | D-0022 scheduled-turn hydration default; any TTL/sweeper (YAGNI until a generation-churn problem is measured). |

## Task Decomposition

**Stage LAT-5B-1 — schema + repository + generation wiring.**
Write scope: schema/migrations (0118 + journal + sync test), a
`conversation-history-coverage` repository (CAS upsert, lookup by
conversation+scope+generation), the provider-generation bump at the channel
wiring (re)connect seam, unit + one Postgres round-trip/CAS test.
AC1, AC5, the bump half of AC4.

**Stage LAT-5B-2 — write + read paths.**
Write scope: `runtime/group-conversation-context.ts` (attestation write
after the persist loop; the two-phase guard at the call site),
`runtime/group-processing.ts` + `runtime/group-processing-context.ts`
(thread `group.conversationId` through — they currently drop it),
`runtime/group-processing-types.ts` (repository port surface), wiring.
Unit tests with fakes: AC2 (incl. persistence-failure non-promotion) + AC3
falsifications, contradiction overwrite.

**Stage LAT-5B-3 — real-Postgres proofs + measurement + closeout.**
Write scope: `apps/core/test/integration/`.
Zero-provider-call proof (extend `group-processing.test.ts:6490` family),
generation-bump re-attestation (Discord close/resume test family,
`discord.test.ts:2081`; shared-transport fan-out via
`provider-account-channel-connect.test.ts:200`; a NEW Slack receiver
lifecycle harness — no existing seam can prove that bump), concurrency CAS
(extend `runtime-lease-generation.postgres.integration.test.ts:37`), guard
statement cost via `measurePostgresOperations` on the real packet path;
goal-prompt doc row; full lanes + closeout. Teams reconnect coverage is
fake-adapter-only until a production SDK client exists — stated in the PR,
never claimed as production proof.

## Risks

- **A false COMPLETE is the poison** (0089's bias rule applies durably):
  the only writers of `complete=true` are server-confirmed exhausted claims
  under the aggregate protocol, generation-fenced. AC2/AC4 falsifications
  target exactly the promotion and missed-gap directions.
- **Generation bump placement** is the correctness linchpin: it must fire on
  every path where live delivery may have gapped (connect, reconnect,
  stream reset). Missing one silently trusts stale completeness — the
  plan's critique pass must enumerate the (re)connect seams per provider.
- **Guard cost**: +1 lookup on incomplete-window turns must not tax the
  LAT-4A baseline (the statement test guards it; join into an existing
  query if measurable).
- **Multi-account same-jid**: coverage keys on the same conversation
  identity the packet builder resolves — the critique verifies no ambiguity.

## Verify Plan

1. Falsify AC2 (promotion), AC3 (generation predicate), AC4 (missing bump)
   once each; record failures.
2. Per stage: smallest suites → local autoreview until clean/adjudicated →
   commit. Implementation via `./forge delegate <stage-id>` (new harness).
3. Closeout: merge main first; full lanes; `verify.py`; ONE 3-lens branch
   autoreview; artifacts; `pr_ready`; PR via the human merge gate.
4. Disposable container `gantry-lat5b-pg`; scratch-DB migration proofs.
5. A read-only `LAT-5B-CRITIQUE` decomposition leaf runs the independent
   Codex critique of this plan via `forge delegate` BEFORE stage 1 starts;
   findings fold back into the plan (re-save) before implementation.
