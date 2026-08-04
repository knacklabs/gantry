---
story: LAT-4B
status: awaiting-approval
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
  - 0089-thread-turns-read-channel-context
  - 0090-sender-allowlist-trigger-only
  - 0091-client-signoff
  - 0092-client-signoff
  - 0093-client-signoff-is-a-pinned-project-gate
  - 0094-conversation-file-trust-program
  - 0095-client-signoff
  - 0096-thread-recency-message-timestamp
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0100-mig-1-client-signoff
---

# LAT-4B — Graph-Write Reduction Plan

## Goal (plain language)

Every inbound (and outbound) message currently re-asserts identities the
database already proved — the app, the model profile, and for thread
messages the entire conversation graph a second time inside the same
transaction. Deleting the provably redundant statements makes message
persistence measurably cheaper: top-level 19 → 15 statements, thread
messages 29 → 16. Nothing user-visible changes except one fix: thread
activity now orders the chat list by the message's own time, like top-level
messages already do (decision 0096).

## Premise (verified on this worktree, main 31e4622a5 — corrects the audit)

- Post-LAT-4A reality: a registered top-level envelope is 19 statements /
  1 transaction, pinned by inbound-envelope-statements.postgres.integration
  .test.ts:66-75. A THREAD envelope is 29 — `ensureThread`
  (canonical-graph-repository.postgres.ts:370-403) re-runs the complete
  `ensureConversation` (+10). No test pins the thread number today.
- The 8 nested repeats each have a byte-identical same-transaction earlier
  statement (same tx from canonical-message-repository.postgres.ts:165;
  outer ensure at :209-219, nested at :220-225 → graph :382-386). Seven are
  onConflictDoNothing; `agents` re-UPDATEs identical values (only effect: a
  second updated_at bump).
- The 2 startup-proven writes are 4 statements on the hot path (apps +
  llm_profiles × two call sites: ensureConversation:312 and
  ensureAgent:171). Startup asserts the seeds exist on every boot
  (storage-service.ts:206-247 gating storage-readiness.ts:105,193); ids are
  constants ('default', 'llm:default').
- The outer conversations write is ALREADY monotonic on the message
  timestamp (GREATEST at graph :364); the nested one falls to currentIso()
  (:314) AND clobbers external_ref_json.isGroup (:363 rewrites
  unconditionally from a builder that omits isGroup). Decision 0096 pins
  message-timestamp recency; deletion makes threads consistent and removes
  the clobber.
- ensureThread has exactly 2 src callers, both already holding the
  conversationId (message repo :220-225; session repo
  canonical-session-repository.postgres.ts:219-232) — the reduction lands
  once for both.
- ensureAgentExists (jobs path, graph :205-247) calls ensureApp itself —
  the hot-path removal must not delete ensureApp; it removes hot-path CALL
  SITES only.
- Outbound replies and hydration persistence use the same saveMessage path
  (channel-wiring.ts:423,527,597,622; group-output-finalization.ts:127;
  group-processing.ts:548,776; group-conversation-context.ts:121) — thread
  wins apply there too, multiplied by hydration batch size.

## In scope (user-locked: SKIPPABLE-only)

1. **Delete the hot-path app/profile call sites.** ensureConversation and
   ensureAgent no longer call ensureApp on the message path (−4 statements
   per envelope: 2 tables × 2 sites). ensureApp itself and
   ensureAgentExists's call stay. No compensating SELECTs — FK violations
   would surface loudly if the startup assertion were ever bypassed.
2. **ensureThread takes the caller's conversationId.** Reduced form:
   threadIdFor + null guard + the single conversation_threads insert; the
   FK is satisfied by the same-transaction ensured row. Both callers pass
   their in-hand id. The nested ensureConversation dies (−9 for threads)
   and with it the wall-clock recency bump and the isGroup clobber
   (decision 0096).
3. **Measurement flips (exact counts, user-locked).**
   EXPECTED_ENVELOPE_STATEMENTS_BY_PROVIDER 19 → 15 (all three providers);
   NEW thread-envelope integration case pinning 16 (first thread pin);
   STATEMENTS_SAVED_PER_PROVIDER and a NEW LAT-4B row in the measurement
   ledger doc (lat-4a-measurement.md stays 4A's history; add a 4B section
   or sibling doc). Recency proof: thread message with an OLD timestamp
   does not reorder listChats; with a NEWER timestamp it does; isGroup
   survives a thread message.
4. **Deferral.** The CONDITIONAL provider/agent/account collapse
   (graph-ready receipt) is recorded via forge defer with trigger:
   post-4B measurement still showing the identity upserts dominating the
   envelope, or the receipt plumbing appearing for another feature.

## Out of scope

Graph-ready receipt plumbing; any change to users/user_aliases/
conversation_participants/messages/message_parts/admission (LOAD-BEARING);
compensating SELECTs; ensureAgentExists (jobs path).

## Surface Impact

- **Runtime behavior**: Changed — fewer statements per envelope; thread
  recency now message-timestamped (decision 0096); isGroup no longer
  stripped by thread messages.
- **API (control/SDK/contracts)**: Unchanged by design.
- **Data/schema**: Read-only — no migration.
- **CLI/ops**: Unchanged by design.
- **UI**: N-A.
- **Docs**: Changed — measurement ledger + goal-prompt premise row.
- **Tests**: Changed — pinned counts flip; new thread pin; recency and
  isGroup falsifiers; ~14 ensureThread mock assertions updated
  (canonical-message-ops-service.test.ts) plus binding/ops/job repo mocks
  if signatures shift.

## Stages

- **LAT-4B-1 — the deletions + measurement flips (single stage).** Write
  scope: apps/core/src/adapters/storage/postgres/,
  apps/core/src/runtime/, apps/core/test/, docs/. Falsifiers: top-level
  pins 15 and thread pins 16 on real Postgres (drop any deletion → count
  test fails); first-contact creation still works for a brand-new
  conversation AND a brand-new thread in one envelope (the deleted
  statements were redundant only for proved identities — assert the
  surviving statements still create everything on first contact);
  old-timestamp thread message does not reorder listChats (0096 falsifier);
  isGroup survives thread traffic; ensureAgentExists jobs path unaffected;
  session-repository caller passes its id (unit-asserted). Then closeout:
  verify.py, ONE 3-lens branch autoreview, artifacts, pr_ready.

## Verification bar

Real Postgres for every count and behavior proof (orchestrator-owned
lanes). Reversible negative controls on each deletion class. Explicit
what-did-not-improve: the ~11 surviving statements (identity CONDITIONALs +
LOAD-BEARING rows) are untouched; wall-clock cost is not measured, only
statement counts.

## Risks

- The `agents` second updated_at bump disappears — nothing reads
  agents.updated_at for ordering (verified: no reader), but the falsifier
  suite should assert agent name/config still refresh on the surviving
  outer call.
- Unit-mock churn (~14 call-shape assertions) — mechanical but wide;
  keep the ensureThread change backward-compatible (optional input field)
  to bound it.
