---
issue: CARDSIMPLE-1
title: One permission surface, family-wide grants
story: CARDSIMPLE-1
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
  - 0099-rate-limits-singleton-authority
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
  - 0102-runtime-hardening-audit-harvest
  - 0103-live-admission-terminal-retention
  - 0104-co-1-recovery-intent-reframe
  - 0105-physical-attachment-workspace-handoff
  - 0106-scheduled-runs-cannot-mutate-jobs
  - 0107-typed-permission-decision-provenance
  - 0108-job-definition-revision-fencing
  - 0109-semantic-capability-job-dependencies
  - 0110-live-ux-capability-dispatcher
  - 0112-legacy-single-canonical-shape
  - 0113-enforce-no-backcompat-architecture-check
  - 0114-canonical-job-owner
  - 0115-autonomous-tool-denial-terminal
  - 0117-scheduled-job-declare-tools-at-creation
  - 0118-identity-scoped-approval-and-grants
  - 0119-provider-neutral-group-approver-bootstrap
  - 0120-local-cli-structured-invocation
  - 0121-autodet-no-classifier-autonomous
  - 0122-capability-template-amendment
  - 0123-recovery-proposal-birthright
  - 0124-bounded-durable-card-delivery
  - 0125-host-only-template-amendment
  - 0126-typed-terminal-denial-event
  - 0127-tagged-setup-action-model
  - 0128-permission-approval-result
  - 0129-capsafe-local-cli-terminal-wildcard
  - 0130-capsafe-capability-run-dispatch-only
  - 0132-adaptive-browser-authentication-access
  - 0133-gantry-tool-correlation-response-meta
  - 0134-autonomous-compound-runcommand-leaf-authorization
  - 0135-browser-model-provider-credential-facade
  - 0136-voice-as-provider-adapter
  - 0137-connector-accounts-mirror-provider-accounts
  - 0144-autonomous-ask-and-wait-chat-parity
  - 0151-browser-navigation-summary
---

# CARDSIMPLE-1 — One permission surface, family-wide grants

## Problem

Owner rulings 2026-08-31/09-01 (spec confirmed: `docs/specs/cardsimple-1-one-permission-surface.md`): every blocked scheduled-job need shows too many surfaces and re-asks too often. Live evidence (job `card-check-2`): one blocker produced a permission card AND repeated "Setup needed" prose messages; one Allow tap left THREE forever-pending `job_permission_handoff` triggers (one per dead priorRunId — fanout at `application/interactions/job-permission-provider-actions.ts:166` → `job-permission-reconciler.ts:498`, undispatchable because the enqueue path never re-activates the paused job, `jobs/execution-finalization.ts:192`); and a durable grant today records the exact normalized argv (`shared/bash-command-parser.ts` `normalizeBashLeafRuleContent`), so allowing `curl <url-A>` grants nothing for `curl <url-B>`. Four read-only Codex sol@xhigh validation passes (plans/exploration/cardsimple-1-v1..v4) grounded every claim below with file:line evidence; their blockers are folded into the confirmed spec.

## Scope / Non-goals

Three bounded tasks deliver the spec:

**Family-wide grants (T1) — minimum version (simplicity pass 2026-09-01).** Six moves:
1. ONE tiny shared synthesizer helper: eligible simple leaf → `RunCommand(<literal argv0> *)` (existing matcher grammar, trailing `*` over remaining argv — `shared/tool-rule-matcher.ts:550`); pipe or any existing durable exclusion → NO suggestion. Called from all three rule-minting lanes (host `permission-suggestion-synthesis.ts:62`, SDK runner `permission-suggestions.ts:262` — which today does not even reject pipes, autonomous recovery `autonomous-bash-recovery-rule.ts:14`); safe non-piped compounds synthesize per leaf. Kept shared because host-only would leave pipes-never-Allow lane-dependent.
2. Admit exactly that family shape in the durable validator (`shared/durable-access-policy.ts:219` leading-wildcard rejection amended); every other rejection retained.
3. One boolean `isFamilyRule` on the successful match result (NOT a three-value classification — exact and capability matches share unchanged behavior).
4. The coordinator runs the existing deterministic rails on the exact command BEFORE honoring a family match ONLY (`runtime/permission-decision-coordinator.ts:84`); exact and capability matches keep the current early return byte-for-byte.
5. On a family rail hit: attach no durable suggestion and expose only `allow_once | cancel` — computed ONCE at the coordinator, the sole seam that clears suggestions and selects the options; no adapter-level duplication.
6. ONE narrow decision record: "family matches are provisional to deterministic rails" — explicitly amends 0040 only; links 0121/0144/JOBPERM-2 as compatible-unchanged (removing the durable suggestion naturally selects the existing `once` path, so JOBPERM-2's grant selection needs no amendment).
Tests: the synthesizer's semantics tested thoroughly once; one delegation smoke test per lane (full lane-parity cross-product DEFERRED — when: a lane acquires distinct synthesis policy); regression on exact rules, rails, pipes. Autonomous stays classifier-free; YOLO not the gate; pinned `local_cli` readiness matching unchanged (`job-readiness-service.ts:393`); family stays `grant: rule`.

**One canonical card (T2) — minimum version (simplicity pass 2026-09-01: reuse 0124's machinery; the card is the render/action surface, NOT a new delivery system).** Eight moves:
1. `raiseSetupPausePermissionPrompt` (`application/jobs/setup-pause-permission-prompt.ts:71`) stays the SOLE fingerprint-keyed ingress — it already validates the current fingerprint, derives route/request identity, and atomically prepares delivery. Its projection target changes to canonical `job_permission_card` rows (a waiter-free row ensure may exist internally but is not a new lifecycle entry point; no public `attachSetupNeed`).
2. Every current blocker becomes a row — the raise function's first-reviewable-grant narrowing (`setup-pause-permission-prompt.ts:122` → `instruction_only`) is removed. Rows render by the three ACTION KINDS (`approve_grant | fix_proposal | instruction` — fix_proposal is live today, `ipc-capability-run-handler.ts:146`), with blocker type as labeling/detail; every currently reachable producer combination is implemented, unreachable combinations DEFERRED (when: a producer emits one, added with its producer-level test). Compound = a RunCommand content case: pipes reformulation-only, safe compounds per-leaf, retry-and-ask as the compound-row action (fingerprint-bound `scheduler_retry_ask` executor retained). `formatSchedulerSetupStory` survives as the row/body projection.
3. Delivery authority stays 0124's EXISTING prompt-identity + outbound item/generation state (bounded attempts, generations, ambiguous/exhausted outcomes, re-raise) — decision 0124 explicitly rejected a separate delivery state machine; none is built. No "setup-origin delivery state".
4. `notified_fingerprint` needs NO ownership migration: 0124's reconciler already sets it on delivered and clears it on exhausted/expired with fingerprint/newest-generation guards (`setup-permission-prompt-reconciliation.postgres.ts:417`); deleting the prose sender makes the marker naturally describe canonical-card delivery.
5. No new sole-card field: durable prompt existence plus the raise result (`raised | already_pending`, `execution-readiness.ts:182`) is the establishment signal that suppresses the setup-terminal send.
6. No migration-wide repointing: the bootstrap re-raise loop, partial recovery's raise/retire and the fingerprint grant guards/requirement-append hooks keep calling the existing seams — only internal rendering/projection changes. Setup-origin rows bypass waiter release, `handoff_pending`, rerun barriers and the job-permission reconciler.
7. Surface constraints (hard): no setup prose on ANY route; the canonical card only on the approver route; no pause-story buttons (the CARDFIX-1 prose-card affordance layer — `setupStoryActionAffordances`, the `MessageActionAffordance` variant, callback parsing and the four provider codec branches — is deleted; the `scheduler_pause_job` MCP task, IPC handler, risk registration and direct tests remain); no second terminal surface.
8. Semantics preserved: 0144 denied-row Reconsider, 0134 pipe/per-leaf/once rules (`once` = no persistable suggestion OR family rail hit), fingerprint-current grant guards, `transient_permission` receipt (`execution-finalization.ts:309`).
DEFERRED: making canonical-card revisions the delivery authority (when: 0124 is deliberately superseded and the old prompt/item system can be deleted atomically).

**Late tap (T3) — minimum version (simplicity pass 2026-09-01).** Six moves, zero-fanout landing first, then the receipt/Run-now UX before T3 is declared complete:
1. No bespoke state model: the EXISTING revision/actionability/expiry guards reject invalid taps (retire revisions, missing actions, cancelled+expired needs — verified sufficient or minimally extended); for a valid single-row action the only new rule is `live waiter lease ? live : late`. Each callback targets exactly one `needId + askingEpoch`, which makes mixed live/late state impossible (no batch-rejection machinery).
2. Zero-fanout (the root-cause fix for the 3-stuck-triggers incident): remove rerun-barrier creation and every reconciler path converting barriers into triggers (`job-permission-provider-actions.ts:166`, `job-permission-durability-state.ts:81`, reconciler `:498`, trigger creator `job-permission-wiring-setup.ts:221`). A late decision creates NO job trigger. Existing stuck rows are operational cleanup, not code.
3. ONE idempotency story: `opId = hash(jobId, needId, askingEpoch, decision)`; purpose-scoped identities `receipt:{opId}` and `run:{opId}` reuse the CARDFIX-1 create-first/deduped pattern (deterministic id, create-first refusal, pg-boss send-id dedupe). A bespoke durable receipt marker is DEFERRED (when: the create-first pattern proves not crash-safe through an ambiguous provider response).
4. Settlement returns a small typed `{opId, decision}` after commit (today acceptance is discarded — `job-permission-wiring-setup.ts:263`, `runtime-live-stop-message-action.ts:240`); NOT another persisted state machine. Late Allow ⇒ one receipt with a `scheduler_run_now` affordance keyed `receipt:{opId}`; late Deny ⇒ one receipt, no Run now, Reconsider retained (0144 unchanged by lateness). Late Allow records the decision with family breadth (T1).
5. Run now: recheck readiness, activate the setup-paused job, create-first the deterministic `run:{opId}` trigger (today `job-management-run-now.ts:268` mints a fresh trigger per callback), enqueue once, settle it failed on dispatch failure; replays reuse the settled trigger and never auto-dispatch. Rides the #462 interactive host lane. Nothing ever auto-runs.
6. Write scope is the named paths its deletion and idempotency moves force (fanout sites, durability port/effects/wiring, the #462 host lane, run-now — enumerated in Task Decomposition); NEITHER JSONB validator is touched unless the existing durable delivery/trigger records cannot hold the derived identities.

**Non-goals:** the remaining GRACE-1 findings (lost retry timer, waiting-job reminders, unregistered-channel courtesy reply, provider-unknown log); egress-gateway policy; YOLO policy; interactive-lane classifier behavior; any change to 0134's piped-command invariant; per-route card projections; pinned local_cli matching semantics; non-job/live-chat permission cards (their consolidation and late-tap behavior are unchanged).

## Acceptance Criteria

- AC1: a blocked scheduled-job need yields exactly ONE actionable surface — the canonical job permission card — on all four providers, for every currently REACHABLE action-kind × blocker combination (approve_grant/fix_proposal/instruction; fix_proposal included — it is live today; compound as a RunCommand content case; unreachable combinations deferred with their producers) and every pause cause (with or without a live run); no "Setup needed" prose message is sent; non-approver notification routes receive no setup card or prose; one durable prompt identity survives ambiguous/exhausted delivery recovery via 0124's existing machinery; `notified_fingerprint` reflects canonical-card delivery through 0124's reconciler; the reconciler does not loop on unnotified pauses; no second actionable terminal card can be sent while the durable prompt is raised/pending.
- AC2: Allow on a simple command records the canonical family rule via the ONE shared synthesizer such that a later run invoking the same argv0 with different args proceeds without asking; a rail hit (destructive/privileged/egress) inside an allowed family still asks and permits Allow-once only; piped commands present no Allow; safe non-piped compounds resolve per-leaf; pinned local_cli readiness matching is unchanged.
- AC3: a late ALLOW (run lease gone) records the same durable decision, replies with exactly one idempotent receipt plus a Run now affordance, creates no barriers and no automatic triggers, and Run now creates at most one deterministic settled-on-failure trigger; a late DENY settles the denial with one receipt, NO Run now, and the denied row stays/re-renders with one-tap Reconsider (0144); `stale` card states (retire revision, no actionable row, cancelled+expired) mutate nothing and show no Run now; nothing ever auto-runs.
- AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.
- AC1/AC2 preservation clauses (grill pass A): AC1 additionally proves the retained card-body projection (`formatSchedulerSetupStory` as row/body source), 0124 bounded delivery + terminal outcomes with operator-only same-identity recovery, the preserved `transient_permission` receipt, normal-Deny no-collapse/Reconsider, and retained retry-and-ask with the Pause AFFORDANCE deleted; AC2 additionally proves the full durable-exclusion set stands (meta-executor/stateful/interpreter/redirect/remote-content — via the single synthesizer test plus one smoke per lane), family grants live in agent authority only, exact reviewed rules and capability grants are byte-for-byte unchanged, autonomous stays classifier-free with YOLO not the gate, and `once` applies exactly when no persistable suggestion exists OR rails prevent a family rule from being honoured.

## Technical Approach

Reuse over invention is the whole design (hardened by the 2026-09-01 simplicity passes, verdicts OVER-BUILT: 4+6+4 cuts, all folded): the family shape already exists in the matcher grammar (only the durable validator and the synthesizer helper change); T2 keeps `raiseSetupPausePermissionPrompt` as the sole ingress and 0124's item/generation machinery as the delivery authority — the canonical card is the render/action surface, no third delivery system; T3 reuses the CARDFIX-1 create-first/deduped idempotency pattern under one `opId`. The rails-before-family ordering lands in `permission-decision-coordinator.ts`: reviewed-rule match found → if `isFamilyRule`, run deterministic rails on the exact command and honor only on rail silence (rail hit ⇒ no durable suggestion, `allow_once | cancel`); otherwise preserve the current early return unchanged. One narrow decision record (`./forge decision new` during T1) amends 0040 only and links 0121/0144/JOBPERM-2 as compatible-unchanged.

Implementer: Codex `gpt-5.6-sol` @ `xhigh` per task (compact-404 mitigations: bounded briefs; if a run dies mid-compaction twice, fall back to the degraded-window protocol already ruled by the owner).

## Decisions

0134 (pipes never durably granted, per-leaf for safe compounds) — honoured and load-bearing in T2's row mapping. 0144 (ask-and-wait chat parity; denied rows keep Reconsider) — honoured; Reconsider rows exempt from collapse. 0106 (runs/triggers never mutate jobs) — family grants update agent-owned permission authority only, never job definitions or access_requirements. 0121 (no classifier on autonomous) — unchanged; the family risk gate is deterministic rails, not the classifier. 0127 (tagged setup action model) — T2's row/action mapping extends the tagged model. 0124 (bounded durable card delivery) — card delivery ownership of notified_fingerprint rides the existing bounded-delivery machinery. NEW decision in T1: family-match-is-provisional — ONE narrow record expressly amending 0040 (rails precede only literal-argv0 family matches; exact reviewed rules keep 0040's order) and linking 0121, 0144 and JOBPERM-2 as compatible and unchanged (a family rail hit attaches no durable suggestion, so the existing `once` path applies with no grant-selection amendment). Decision 0134 is ACCEPTED (recorded 2026-09-01, confirmed_by Ravi Kiran Vemula) and binding.

## Surface Impact

Permission rule synthesis (three lanes unified), durable-access validation, permission decision ordering, the whole setup-pause notification surface (prose send removed; one card), job-permission card creation/projection/callback lifecycle, scheduler notification wiring, four provider codecs shrink (prose-card buttons deleted). No settings schema or SDK contract changes expected; no new ownership markers and no ownership move — 0124's existing reconciliation remains the delivery authority.

## Task Decomposition

- CARDSIMPLE-1-T1 — Family-wide grants (minimum version: shared synthesizer helper, validator family shape, isFamilyRule + rails-before-family at the coordinator, one narrow decision record, tests). Contract: AC2, AC4. dependencies: [].
- CARDSIMPLE-1-T2 — One canonical card (minimum version: raise seam re-projects to card rows, every-blocker rows by action kind, 0124 machinery stays delivery authority, prose send + pause-affordance layer deleted, approver-route-only, 0144/0134 semantics, tests). Contract: AC1, AC4. dependencies: [].
- CARDSIMPLE-1-T3 — Late tap (minimum version: live-iff-waiter-lease rule on existing guards, zero-fanout deletion first, one opId idempotency for receipt + Run now via the CARDFIX-1 pattern and the #462 lane, tests). Contract: AC3, AC4. dependencies: [CARDSIMPLE-1-T1, CARDSIMPLE-1-T2] — late Allow persists FAMILY breadth (T1) through T2's canonical callback surface.

T1 and T2 are scope-disjoint and DAG-parallel-eligible; T3 follows both. T3's write scope is the paths its own deletion and idempotency moves force — the rerun-barrier fanout sites (`application/interactions/job-permission-provider-actions.ts`, `job-permission-durability-state.ts`, `job-permission-reconciler.ts`), the durability port/effects/wiring (`domain/ports/job-permission-durability.ts`, `application/interactions/job-permission-durability.ts`, `app/bootstrap/job-permission-durability-wiring.ts`, `app/bootstrap/job-permission-wiring-setup.ts`), the #462 host lane (`app/bootstrap/runtime-live-stop-message-action.ts`) and `application/jobs/job-management-run-now.ts` — no arbitrary file count; the JSONB validators stay deferred unless existing records cannot hold the derived identities. T2's scope includes `application/jobs/setup-pause-permission-prompt.ts`, the card projection, `domain/message-actions.ts`, `channel-message-action-router.ts` and the four provider codecs (deletion-heavy). Per-task verify: T1 = synthesizer semantics once + one smoke per lane + exact-rule/rail/pipe regressions + Postgres decision-chain/memory/durable-authority; T2 = jobs/application/channels unit + jobperm card + setup-prompt Postgres suites with explicit no-prose, one-surface, route-isolation, marker-outcome and recovery cases; T3 = jobperm-durability + run-now anchors (`test/unit/application/jobperm-durability.test.ts:1749`, `jobs-use-cases.test.ts:3353`) covering zero-barrier late decisions, exactly-once receipt/Run now, activation-before-trigger, failed-trigger settlement.

## Risks

- The rails-ordering change (T1) touches every permission decision path — the new decision record must pin that interactive-lane behavior and 0121 autonomous behavior are otherwise unchanged; full permission unit + Postgres decision-chain suites gate it.
- T2 is the big cut: removing the prose send must leave 0124's existing `notified_fingerprint` reconciliation and terminal suppression describing canonical-card delivery — the reconciler-loop and second-surface regressions (validation pass 1 findings 8–9) are explicit test targets; no ownership move is performed.
- Two card systems merging risks orphaning setup actions for shapes the living card never carried — mitigated by implementing and testing every currently reachable producer shape directly (fix_proposal included).
- Review budgets: T2 will exceed defaults; set task review_budget with reasons at decomposition time (lesson: budgets are raisable with a reason, no hard cap).

## Verify Plan

Per task: `npx tsc --noEmit`; `npm run check:architecture`; focused unit dirs (`apps/core/test/unit/application/ apps/core/test/unit/jobs/ apps/core/test/unit/channels/ apps/core/test/unit/shared/ apps/core/test/unit/runtime/`); Postgres lane host-side (permission-decision-chain, permission-decision-memory, permission-durable-authority, job-lifecycle, job-coordination-state, setup-permission-prompt-preparation + the jobperm card suites); autoreview local per stage with a brief pinning the AC slice; story closeout: full sweep + verify.py. Live check after deploy: block a job on `curl <url>`, Allow ⇒ family rule recorded ⇒ a rerun with a different URL proceeds without asking; block on `ls | wc -l` ⇒ card shows reformulation row + retry-and-ask, no Allow; late tap after run death ⇒ one receipt + Run now, zero pending handoff triggers in job_triggers.
