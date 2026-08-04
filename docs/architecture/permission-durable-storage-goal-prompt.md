# Goal: Permission durable-storage simplification (Group A cycle)

**Status: awaiting user sign-off.** Implementation runs through the
gantry-goal-pipeline (Codex implements, per stage below), on a fresh branch off
main (base includes #228 + #229).

## Provenance

Four inputs, in order; later entries corrected earlier ones:
1. `coordination-representation-audit-2026-07-18.md` Group A + carried smells — the original plan.
2. Fable architecture review — restructure: merge the schema items, kill the
   claims table, sweep #228 leftovers, delete review-each replay; 12 invariants.
3. `permission-durable-storage-plan-validation.md` (Codex) — stale-citation
   corrections; the full relational contract the schema must carry.
4. `permission-storage-fable-codex-verification.md` (Codex arbitration) —
   Claim 1 CONFIRMED (caller path corrected), Claim 2 PARTIAL (one envelope row
   viable; the *minimal* column sketch loses Review-each + expiry invariants),
   Claim 3 CONFIRMED (delete replay, terminalize atomically), order = sweep →
   orchestrator → schema.

## Why

The permission durable-storage subsystem caused the #228 churn: claim state
machine encoded as jsonb key presence/absence, a recovery-envelope copied into
N member rows and compared by `JSON.stringify` identity, and the
recover-after-restart protocol hand-copied (and already drifting) across all
four channel providers. Two claim-equality functions with different semantics
are both live; the claim SQL rebuilds `providerAliases` per row, so sibling
batch rows can legitimately differ and the stringify comparison mismatches on
restart recovery (arbitration-confirmed failure).

## Stages (each leaves the tree green; Codex per stage; autoreview per stage)

### Stage 1 — Sweep: delete dead question-recovery state + review-each replay
- Delete #228's write-only question-recovery machinery: no behavioral reader
  exists for `QuestionRecoveryEnvelope.callbacks/.otherPrompts/
  .deliveredQuestionIndexes/.answers`. Kill `bindPendingQuestionInteractionCallback`,
  `bindPendingQuestionOtherPrompt`, `createDurableQuestionCallback` + their four
  provider call sites, and `recordDurableQuestionPromptDelivered` (fails closed
  on a write nobody reads — a DB blip currently blocks question delivery for
  nothing). Keep `selections` + `completedQuestionIndexes` (read back live).
- Delete cross-restart review-each replay (`replayPersistedReviewEach`, the
  `reviewEachReplays` promise-memo, `batch.phase`, the phase-flip special case
  in the claim SQL). Restart mid-"Review each" → **atomically terminalize** the
  unfinished review-each state (stale prompts get buttons stripped + marked
  expired) and the agent re-asks. `allow_persistent_rule` + reviewed-capability
  approvals keep plain durable recovery (they un-pause jobs / write grants).
- Verification: grep-proven zero readers for every deleted symbol; invariants
  1-3 below stay green; full unit + integration.

### Stage 2 — One recovery orchestrator (A1 + app-layer dedup)
- One `recoverDurablePermissionDecision(hooks)` in the application layer with
  **two locate strategies** (by-scope for Slack/Teams, by-message for
  Discord/Telegram — the drift is structural, both entry paths must survive).
- Providers supply transport hooks only: `authorize`, `terminalize(receipt)`,
  `feedback(text)` (mandatory — Discord is currently silent on most recovery
  failures), callback parsing. Delete the four `recovered*PermissionDecision`
  copies and per-provider equality helpers.
- Consolidate the app-layer duplicates: one claim parser, one folder extractor,
  ONE claim-equality (field-wise; kill `samePersistedPermissionClaim`'s
  stringify comparison — the alias-divergence landmine).
- UX ride-along: unify the four "resolved via X after restart" strings into the
  normal receipt format; every recovered click gets a terminal, visible outcome.

### Stage 3 — Merged schema cutover (#1 + #2; A2 dies as a by-product)
- One `permission_prompts` (envelope) row per prompt; member interaction rows
  reference it (`envelope_id`, `index`, `status`) — envelope copies and both
  stringify-identity groupings disappear (grouping becomes an FK).
- Claim as columns on the envelope row — but per the arbitration + plan
  validation, the relational contract must carry (not drop): settlement state,
  approver, canonical batch id, provider aliases, scope fields, **per-member
  expiry** (an expired member must still block or cancel the batch claim), and
  the run-lease columns (`runLeaseToken`, `runLeaseFencingVersion` — currently
  read via `payload->>` in SQL). Single-winner claim = one atomic UPDATE with
  the expiry guard.
- Promote the five `listPendingInteractions`+JS-filter lookups to indexed
  queries on the new columns.
- No data migration fidelity required (active dev; DB reset acceptable) — but
  ALL 12 behavioral invariants below must hold on the new schema.
- A3 (review-dedup Sets → durable content-hash index) is **deferred** to the
  durable-work-primitive cycle (needs a content-hash key that doesn't exist;
  UX-only per the audit's own rating). Note in cycle notes so post-restart
  duplicate prompts aren't re-triaged as bugs.

## Invariant test contract (write as tests in Stage 1, keep green through 3)

1. Question reopen iff `kind='question' AND status='cancelled'`; pending
   duplicates untouched; resolved rows never reopen; one retry after
   lease-dead cancel.
2. Lease-liveness cancel fails closed: malformed/absent lease state ⇒ not
   cancellable.
3. Reviewed-capability prompts record a durable row before prompting; bind
   failure ⇒ prompt withheld (protects bca99d2ad).
4. Single-winner claim is one atomic statement incl. expiry guard; two
   concurrent claims ⇒ exactly one winner.
5. Partial batches unclaimable: every member pending + unexpired, or the batch
   claim loses (or the batch cancels — explicit either way).
6. Release restores claimability exactly (by-scope and by-message lookups).
7. `already_decided` vs retryable distinction survives settlement.
8. Idempotent re-record never clobbers claim/settlement.
9. Reserved deciders (`runtime`/`system`/`auto_classifier`) never claim
   non-cancel modes.
10. Channel affinity on recovery enforced in the orchestrator, not per-provider.
11. Persisted intent wins over the incoming click on an already-claimed prompt.
12. Resolve is idempotent by state (replaces the blind double-resolve).

## Non-goals
- Groups B1/B2/C of the audit (separate cycles; only the request-only-capability
  dedupe key merges conceptually into deferred A3).
- No re-introduction of durable QUESTION recovery (#228 stance stands; Stage 1
  only deletes its leftovers).
- No CHECK-constraint hardening pass; no multi-host question-selection
  durability (flagged, deferred).
- No backward compatibility / data migration fidelity.
