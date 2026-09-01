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

**Family-wide grants (T1).** Allow on a simple external command records a durable command-family rule instead of exact argv. Canonical shape is the EXISTING matcher grammar `RunCommand(<literal argv0> *)` (trailing `*` over remaining argv — `shared/tool-rule-matcher.ts:550`; NOT new parser syntax); the durable-access validator's leading-wildcard-breadth rejection (`shared/durable-access-policy.ts:219`) is amended to admit exactly this literal-argv0 family shape. ONE shared family-rule synthesizer replaces exact-argv synthesis in all three lanes that mint command rules: host `application/permissions/permission-suggestion-synthesis.ts:62` (`commandRules`), SDK runner `adapters/llm/anthropic-claude-agent/runner/permission-suggestions.ts:262`, autonomous recovery `shared/autonomous-bash-recovery-rule.ts:14`. A family match is PROVISIONAL — and this applies to FAMILY matches ONLY (requirements grill 2026-09-01): deterministic destructive/privileged/egress rails evaluate the exact command before a `RunCommand(<argv0> *)` family match is honored (today reviewed-rule matches return before rails — `runtime/permission-decision-coordinator.ts:84`); a rail hit downgrades to ask and that Allow is once-only. Exact reviewed rules and capability grants behave exactly as today. Autonomous runs stay classifier-free; the YOLO denylist is NOT the gate. The new decision record EXPLICITLY AMENDS: 0040 narrowly (rails precede only a `RunCommand(<literal argv0> *)` family match; exact reviewed rules keep 0040's order), 0121/0144's approval-permanence wording for the family rail-hit case, and JOBPERM-2's grant-selection rule narrowly (`once` also applies when rails prevent a family rule from being honoured — still `rule | once`, no third mode). Implementation seam (grill pass A): policy evaluation returns a TYPED match classification (`family_rule` | exact | capability) alongside `matchedRule` (`shared/tool-execution-policy-service.ts:90-225`), the coordinator runs rails only for typed literal-argv0 family grants and keeps the early return otherwise (consumers: ipc-permission-classifier-decision.ts:121, core-tool-permission-coordinator.ts:61, inline-agent-loop-tools.ts:389); a typed family-rail-hit propagates to EVERY prompt constructor forcing suggestions-absent + `allow_once | cancel` options (today `railRequiresApproval` only vetoes classifier auto-allow — ipc-permission-classifier-decision.ts:307-435; SDK scheduled gate tool-permission-gate.ts:520). The shared synthesizer is the SOLE source for all three lanes (the SDK lane today does not even reject pipes — permission-suggestions.ts:262) with a parameterized lane-parity matrix: simple, safe compound, pipe, interpreter, destructive redirect, remote-content. Scope: simple external commands eligible for durable RunCommand access — existing meta-executor/stateful/interpreter/redirect/remote-content exclusions stand; pinned `local_cli` readiness matching (exact string inclusion, `application/jobs/job-readiness-service.ts:393`) is explicitly unchanged. Family stays `grant: rule` (JOBPERM-2 rule|once — breadth widening, not a third mode; `domain/ports/job-permission-durability.ts:13`). New decision record: rails-before-reviewed-rule ordering for family matches.

**One canonical card (T2).** The job permission card (`job_permission_card`, the multi-need aggregate) becomes the only surface for every blocked need class. The setup-pause permission prompt (`application/jobs/setup-pause-permission-prompt.ts` — a second card implementation) folds into it; the standalone "Setup needed" prose SEND is removed while `formatSchedulerSetupStory` survives as the card-body/row projection (it already feeds `decisionReason`, `setup-pause-permission-prompt.ts:154`). Card creation becomes setup-fingerprint-backed and independent of a live run lease via a NEW fingerprint-keyed `attachSetupNeed` ingress with no waiter and a durable `PermissionApprovalRequest` snapshot, called from the shared post-pause notifier so ALL pause sites funnel through it (today attachment rejects a missing lease and the allow path needs a live-run snapshot — `app/bootstrap/job-permission-durability-wiring.ts:215`, `application/interactions/job-permission-durability.ts:226`); covering creation-time, preflight, final-setup, denial/timeout and partial-recovery pauses. Setup-origin rows get their OWN delivery state: bounded automatic attempts (0124), then explicit operator recovery creating a new revision under the same card/fingerprint identity — NEVER `handoff_pending`, never a rerun barrier (`job-permission-reconciler.ts:125/:313` today treats exhaustion as live-run handoff); `notified_fingerprint` ties to that delivery state. Folding the prompt is a MIGRATION, not a deletion: the bootstrap re-raise/reconcile loop (`runtime-services-permission-card.ts:5/:27`), partial recovery's raise+retire (`application/jobs/job-permission-recovery.ts:162/:267`) and the wiring's route resolution + setup-fingerprint grant guards (`setup-pause-permission-wiring.ts:86`) are re-pointed at canonical-card ensure/recover/retire-by-fingerprint operations, preserving the persistent-grant guard and requirement-append hooks (tests: fingerprint replacement; resolved-by-another-grant retirement). The row/action mapping is defined over the REAL unions (requirements grill): action shapes `approve_grant | fix_proposal | instruction` (`shared/job-setup-action.ts:17`) crossed with the blocker-type axis (tool/credential/browser/MCP/local-CLI — `domain/job-types.ts:74`); a compound command is a RunCommand content case inside the tool blocker type. `instruction`-action blockers render as instruction rows, never prose. Delivery keeps 0124's bounded automatic retries; post-exhaustion recovery is operator-initiated under the SAME durable prompt identity. Card delivery/revision becomes the sole owner of `notified_fingerprint` (today the prose send marks it — `jobs/execution-readiness.ts:232`), and a durable sole-card-established signal suppresses the setup-terminal send (`jobs/execution-notifications.ts:396` path) so a second actionable surface can never leak; delivery exhaustion stays retryable. The `transient_permission` completed-with-limits receipt is preserved (already exempt — `jobs/execution-finalization.ts:309`). Deny keeps 0144: denied rows stay on the living card with one-tap Reconsider (`application/interactions/job-permission-card-projection.ts:129`), exempt from any collapse. CARDFIX-1 cut is explicit: the pause-story affordance path (`setupStoryActionAffordances` + the prose-card button codecs on all four providers) is deleted with the prose send; retry-and-ask survives as the canonical card's compound-row action (fingerprint-bound `scheduler_retry_ask` executor retained); the Pause job BUTTON is dropped — deletion scoped to the prose-card `MessageActionAffordance` variant, callback parsing and the four provider codec branches ONLY; the `scheduler_pause_job` MCP task, IPC handler, risk registration and direct pause tests remain (it stays the normal chat/CLI/MCP scheduler operation). Compounds per 0134/0144 exactly: piped commands NEVER get Allow (reformulation-only row); safe non-piped compounds resolve per-leaf (family rules apply per leaf); `once` applies in exactly two cases — no persistable suggestion exists, or a typed family-rule rail hit prevents the suggested rule from being honoured. Route ownership: the approver route alone owns the card; other notification routes see nothing until the terminal outcome.

**Late tap (T3).** The card callback gains a tap-time liveness check with a THREE-STATE matrix evaluated per `needId + askingEpoch` (grill pass C): `live` = actionable row, need `asking`, a matching waiter lease live; `late` = actionable non-retire row, need `asking | handoff_pending | handed_off`, no live waiter lease (a retired waiter is evidence of lateness, not a card state); `stale` = retire revision, no actionable row, or cancelled+expired — mutate nothing, no receipt, no Run now; a mixed live/late batch is rejected rather than issuing an ambiguous Run now (today `asking|handoff_pending|handed_off` are decisionable with no lease check — `job-permission-provider-actions.ts:150`; dead waiters retire first — reconciler `:257`; once-expiry sets cancelled+expiredAt). Live ⇒ today's flow. Late ALLOW ⇒ record the decision exactly as if live (family breadth included), reply with ONE receipt line plus a Run now button; never auto-rerun. Late DENY (requirements grill) ⇒ one denial receipt, NO Run now, and the denied row stays/re-renders with one-tap Reconsider — 0144's shape unchanged by lateness. Allow creates ZERO rerun barriers and ZERO job triggers (deletes the per-dead-priorRunId fanout at `job-permission-provider-actions.ts:166` / `job-permission-durability-state.ts:81` / reconciler `:498`); only a Run now tap creates exactly one job-scoped trigger — after making the job runnable — and a failed dispatch settles that trigger instead of leaving it pending. Concretely (grill pass C): `decideCardAction` returns a TYPED durable post-settlement receipt outcome (today it returns only acceptance and the host handler discards it — `job-permission-wiring-setup.ts:263`, `runtime-live-stop-message-action.ts:240`); the #462 host lane sends exactly ONE idempotent receipt (durable receipt marker, so callback retries/crashes cannot double-send) carrying a `scheduler_run_now` affordance whose action identity derives from `{jobId, needId, askingEpoch, decision}`; the run-now use case rechecks readiness, activates the setup-paused job, creates exactly THAT deterministic trigger id (today `job-management-run-now.ts:268` mints a fresh trigger per callback), enqueues, and marks it failed on dispatch failure; replays reuse the same settled trigger and never auto-dispatch. Late Deny returns the same receipt outcome with no affordance and retains Reconsider.

**Non-goals:** the remaining GRACE-1 findings (lost retry timer, waiting-job reminders, unregistered-channel courtesy reply, provider-unknown log); egress-gateway policy; YOLO policy; interactive-lane classifier behavior; any change to 0134's piped-command invariant; per-route card projections; pinned local_cli matching semantics; non-job/live-chat permission cards (their consolidation and late-tap behavior are unchanged).

## Acceptance Criteria

- AC1: a blocked scheduled-job need yields exactly ONE actionable surface — the canonical job permission card — on all four providers, across the full action-shape × blocker-type matrix (approve_grant/fix_proposal/instruction × tool/credential/browser/MCP/local-CLI, compound as a RunCommand content case) and every pause cause (with or without a live run); no "Setup needed" prose message is sent; non-approver notification routes receive no setup card or prose; one durable prompt identity survives ambiguous/exhausted delivery recovery; `notified_fingerprint` is owned by card delivery; the reconciler does not loop on unnotified pauses; no second actionable terminal card can be sent while the sole card is established/pending.
- AC2: Allow on a simple command records the canonical family rule via the ONE shared synthesizer such that a later run invoking the same argv0 with different args proceeds without asking; a rail hit (destructive/privileged/egress) inside an allowed family still asks and permits Allow-once only; piped commands present no Allow; safe non-piped compounds resolve per-leaf; pinned local_cli readiness matching is unchanged.
- AC3: a late ALLOW (run lease gone) records the same durable decision, replies with exactly one idempotent receipt plus a Run now affordance, creates no barriers and no automatic triggers, and Run now creates at most one deterministic settled-on-failure trigger; a late DENY settles the denial with one receipt, NO Run now, and the denied row stays/re-renders with one-tap Reconsider (0144); `stale` card states (retire revision, no actionable row, cancelled+expired) mutate nothing and show no Run now; nothing ever auto-runs.
- AC4: existing unit and Postgres integration suites pass; tsc and check:architecture green.
- AC1/AC2 preservation clauses (grill pass A): AC1 additionally proves the retained card-body projection (`formatSchedulerSetupStory` as row/body source), 0124 bounded delivery + terminal outcomes with operator-only same-identity recovery, the preserved `transient_permission` receipt, normal-Deny no-collapse/Reconsider, and retained retry-and-ask with the Pause AFFORDANCE deleted; AC2 additionally proves the full durable-exclusion set stands (meta-executor/stateful/interpreter/redirect/remote-content), family grants live in agent authority only, exact reviewed rules and capability grants are byte-for-byte unchanged, autonomous stays classifier-free with YOLO not the gate, and `once` applies exactly when no persistable suggestion exists OR rails prevent a family rule from being honoured.

## Technical Approach

Reuse over invention throughout: the family shape already exists in the matcher grammar (only the durable validator and synthesizers change); the canonical card, its revision/settlement machinery (JOBPERM-2/3) and the retire semantics are reused as-is — T2 folds the setup-pause prompt INTO them rather than building a third system; the #462 provenance lane and the deterministic-trigger idempotency patterns from CARDFIX-1 carry over unchanged. The rails-before-family ordering change lands in `permission-decision-coordinator.ts` with an EXPLICIT algorithm: reviewed-rule match found → if `matchClassification === 'family_rule'`, run deterministic rails on the exact command and honor the match only on rail silence (rail hit ⇒ ask with once-only durability); if `exact` or `capability`, preserve the current early return unchanged. That ordering change is recorded as a new decision (`./forge decision new` during T1) because it supersedes the return-early behavior 0040-lineage code relies on today.

Implementer: Codex `gpt-5.6-sol` @ `xhigh` per task (compact-404 mitigations: bounded briefs; if a run dies mid-compaction twice, fall back to the degraded-window protocol already ruled by the owner).

## Decisions

0134 (pipes never durably granted, per-leaf for safe compounds) — honoured and load-bearing in T2's row mapping. 0144 (ask-and-wait chat parity; denied rows keep Reconsider) — honoured; Reconsider rows exempt from collapse. 0106 (runs/triggers never mutate jobs) — family grants update agent-owned permission authority only, never job definitions or access_requirements. 0121 (no classifier on autonomous) — unchanged; the family risk gate is deterministic rails, not the classifier. 0127 (tagged setup action model) — T2's row/action mapping extends the tagged model. 0124 (bounded durable card delivery) — card delivery ownership of notified_fingerprint rides the existing bounded-delivery machinery. NEW decision in T1: family-match-is-provisional — expressly amending 0040 (narrow rails-first for family matches only), 0121/0144 (approval-permanence at the family rail-hit) and JOBPERM-2's grant selection (`once` also on rail-blocked family). Decision 0134 is ACCEPTED (recorded 2026-09-01, confirmed_by Ravi Kiran Vemula) and binding.

## Surface Impact

Permission rule synthesis (three lanes unified), durable-access validation, permission decision ordering, the whole setup-pause notification surface (prose send removed; one card), job-permission card creation/projection/callback lifecycle, scheduler notification wiring, four provider codecs shrink (prose-card buttons deleted). No settings schema or SDK contract changes expected; one storage-adjacent change (sole-card/notified_fingerprint ownership markers) stays inside existing card-record JSON.

## Task Decomposition (DAG)

- CARDSIMPLE-1-T1 — Family-wide grants: shared synthesizer, durable-validator family shape, rails-before-family ordering + decision record, tests. Contract: AC2, AC4. dependencies: [].
- CARDSIMPLE-1-T2 — One canonical card: fold setup-pause prompt into job_permission_card, fingerprint-backed lease-free creation, row/action mapping for every shape (pipes reformulation-only, retry-and-ask compound row), notified_fingerprint + sole-card suppression, prose send + Pause button deletion, approver-route-only, 0144 exemption, tests. Contract: AC1, AC4. dependencies: [].
- CARDSIMPLE-1-T3 — Late tap: live|late|stale state matrix, zero-fanout Allow, typed receipt outcome + idempotent receipt marker, deterministic single settled Run now trigger via the #462 lane, tests. Contract: AC3, AC4. dependencies: [CARDSIMPLE-1-T1, CARDSIMPLE-1-T2] — late Allow persists FAMILY breadth (T1) through T2's canonical callback surface.

T1 and T2 are scope-disjoint and DAG-parallel-eligible; T3 follows both. T3's write scope must include the durability port (`domain/ports/job-permission-durability.ts:122`), durability effects (`application/interactions/job-permission-durability.ts:98`), durability wiring (`:190`), the handoff trigger creator (`job-permission-wiring-setup.ts:221`), both JSONB validators (worker-coordination-interaction-repository.postgres.ts:341, job-permission-need-repository.postgres.ts:588) and `job-management-run-now.ts`; T2's must include `domain/message-actions.ts`, `channel-message-action-router.ts` and the four provider codecs. Per-task verify contracts (not one shared list): T1 = permission unit suites + lane-parity matrix + Postgres decision-chain/memory/durable-authority; T2 = jobs/application/channels unit + jobperm card + setup-prompt Postgres suites, with explicit reconciler-no-loop and no-second-surface regression cases (validation pass 1 findings 8–9); T3 = jobperm-durability + run-now failure anchors (`test/unit/application/jobperm-durability.test.ts:1749`, `jobs-use-cases.test.ts:3353`) covering all matrix rows, zero-barrier Allow, idempotent receipt/Run now, activation-before-trigger, failed-trigger settlement.

## Risks

- The rails-ordering change (T1) touches every permission decision path — the new decision record must pin that interactive-lane behavior and 0121 autonomous behavior are otherwise unchanged; full permission unit + Postgres decision-chain suites gate it.
- T2 is the big cut: removing the prose send breaks `notified_fingerprint` bookkeeping and terminal suppression unless ownership moves atomically — the reconciler-loop and second-surface regressions called out by validation pass 1 (findings 8–9) are explicit test targets.
- Two card systems merging risks orphaning setup actions for shapes the living card never carried (credential/capability/instruction) — the row/action mapping table is written first and reviewed in the task grill.
- Review budgets: T2 will exceed defaults; set task review_budget with reasons at decomposition time (lesson: budgets are raisable with a reason, no hard cap).

## Verify Plan

Per task: `npx tsc --noEmit`; `npm run check:architecture`; focused unit dirs (`apps/core/test/unit/application/ apps/core/test/unit/jobs/ apps/core/test/unit/channels/ apps/core/test/unit/shared/ apps/core/test/unit/runtime/`); Postgres lane host-side (permission-decision-chain, permission-decision-memory, permission-durable-authority, job-lifecycle, job-coordination-state, setup-permission-prompt-preparation + the jobperm card suites); autoreview local per stage with a brief pinning the AC slice; story closeout: full sweep + verify.py. Live check after deploy: block a job on `curl <url>`, Allow ⇒ family rule recorded ⇒ a rerun with a different URL proceeds without asking; block on `ls | wc -l` ⇒ card shows reformulation row + retry-and-ask, no Allow; late tap after run death ⇒ one receipt + Run now, zero pending handoff triggers in job_triggers.
