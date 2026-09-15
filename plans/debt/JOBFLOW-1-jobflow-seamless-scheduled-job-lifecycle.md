---
issue: JOBFLOW-1
title: JOBFLOW: seamless scheduled-job lifecycle
status: approved
saved: 2026-08-12T12:28:23+00:00
story: JOBFLOW-1
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
---

# Plan — JOBFLOW-1: Seamless scheduled-job lifecycle

Battle-tested through 15 adversarial validation passes (1 terra-xhigh,
14 sol-xhigh); pass 15 returned ZERO plan-level blockers. The full pinned
contract text (state machines, identities, transaction boundaries,
file:line evidence) is the validated plan v15 — carried verbatim into this
repo as `plans/JOBFLOW-contract-appendix.md` in the same commit as this
plan; the appendix is normative for decomposition and review briefs.

## Problem

Scheduled jobs stall silently instead of asking their owner. The KnackLabs
incident exposed seven stacked layers; the structural defects: (a) failed
card delivery is recorded as a human denial and resolves the durable
interaction row, so the owner NEVER got a working Allow/Deny button in
production; (b) denial evidence travels as parseable marker strings;
(c) blocker state mixes `nextAction` strings + `grantable` booleans with a
silently-lenient parser; (d) capability template mismatches dead-end
instead of producing a fix the owner can approve; (e) job prompts carry
system mechanics instead of business logic. `forge findings patterns`
flags `delivery-semantics` RECURRING x3 at jobs/execution-readiness — this
epic IS the consolidation: the invariant decisions in S1 plus the S3
delivery cutover retire the class.

## Scope / Non-goals

In scope: typed terminal-denial events (S2a); tagged setup-action model +
wire schema + total offline migration (S2b); durable card delivery on the
outbound subsystem with defined recovery for every outcome, all four chat
adapters (S3); host-compiled fix proposals + durable approve→resume,
closing D-0057 (S4); one shared scheduled-run guidance block (S4); live
acceptance gate incl. the KnackLabs prompt sweep (S5).

Non-goals: delivered-prompt interactive semantics (unchanged); the
classifier (interactive-only, 0121); MEM-1; JobPrimingService cleanup;
guidance diet; 0115's three excluded Anthropic guards (model-validation,
wait-only, network) stay non-terminal.

## Acceptance Criteria

1. Every terminal autonomous denial in scope is typed and observable
   (durable idempotent event; status, visibility, finalization read it;
   no marker strings survive).
2. A setup pause produces a card with WORKING buttons; delivery is bounded
   (cap 4) with a defined outcome for every path (delivered / ambiguous /
   exhausted / expired / cancelled) and delivery failure is never recorded
   as a human denial on any channel.
3. A recognized template mismatch yields a host-compiled fix-proposal
   card; owner approval applies both templates (base + flagged, pinned
   paths) and durably resumes affected jobs.
4. Job prompts carry business logic only; the KnackLabs prompt sweep
   completes inside the live gate with owner-approved text.
5. The live gate passes on the real KnackLabs job in the owner's Telegram,
   including the crash/restart fault matrix (kill between prep/dispatch,
   after send-begun, during reconciliation).

## Technical Approach

Story chain (forge dependencies point backwards only):
S1 docs → S2a → S2b → S3 and S4 → S5.

- S1 — Decision/spec reconciliation (docs only, merged first). Amends 0117
  (bounded durable delivery supersedes accepted lost/duplicate cards, incl.
  echoes in preflight-1.md and autonomous-jobs.md), 0122 (host-only
  authorship; identity = canonical proposedTemplates, argv out; both
  pinned-path templates), 0123 (amendment-surfacing narrowed to host-only;
  birthright tools otherwise intact), 0115 (declarative denials terminal on
  scheduled runs; fix_proposal outcome; the two Anthropic guards
  protected-capability + memory-boundary enter the sweep). Closes D-0057.
  Carries the transition graph, idempotency key table, and the canonical
  eleven-surface impact matrix as its appendix.
- S2a — Typed terminal-denial EVENT cutover. Reuses JOB_TOOL_DENIED with
  an extended payload; append is REQUIRED (non-swallowing) and precedes
  finalization; append failure converts to a run error into finalization's
  existing retry branch; one nullable idempotency_key column + partial
  unique on (app_id, idempotency_key) with conflict-skips-side-effects;
  lowest event_id per run is authoritative; three durable read seams
  (finalization, status formatting, visibility); access preflight rerouted
  through readiness (assert helper deleted).
- S2b — Tagged setup-action cutover. One union
  (approve_grant{PermissionAuthorityAddition} | fix_proposal{proposalId} |
  instruction{text}) replaces nextAction+grantable; strict storage parser
  (specific remediation error, no partial arrays, camelCase removed); one
  external event schema for both writers; authored OpenAPI setup schema;
  total offline migration (legacy non-ready rows → typed instruction;
  notified_fingerprint set equal — no renotification storm).
- S3 — Card delivery on the outbound subsystem. One atomic preparation
  (interaction + prompt + full outbound aggregate, job locked+revalidated);
  prompt identity = new row per issue, partial unique across non-terminal
  states on (job_id, setup_fingerprint); generation-aware aggregate
  idempotency (setup_permission_prompt:<promptId>:<generation>);
  send_begun_at lease checkpoint; settlement attaches the provider locator
  in-transaction; idempotent reconciler + prompt-expiry scan on the 5s
  tick; setup.deliveryNotice display seam; typed
  PermissionApprovalResult union cut over across ALL listed consumers and
  all four adapters (prepared-send ports for all four; delivery failure
  never a denial; delivered:'unknown' never retried); human claims never
  clobbered (claimed→superseded only for authoritative invalidation);
  recovered cards terminalize only after full settlement; one-transaction
  job delete/cancel; dormant promotion-offer lane deleted narrowly.
- S4 — Host-compiled fix proposals + run guidance. Agent-authored
  amendment path removed; host handler invokes the compiler/proposal
  service in-path (event is observability); compiler = exactly-one
  literal-prefix match + trailing slots/flags, values wildcarded, both
  pinned-path templates, mixed-glob templates ineligible; durable
  approval-intent row inside the amendment transaction (app-wide scope,
  resumed-or-superseded completion) closes D-0057; canonical_key data
  migration (keep-newest); argv redaction (--account email, NAME@host);
  one scheduled-run guidance block in the shared prompt seam.
- S5 — Live acceptance gate (not an implementation story). The exact
  flagged argv on the real job → card with buttons → owner tap → both
  templates → durable resume → leads written → no duplicate card; fault
  matrix at the three kill points; final step = owner-approved prompt
  sweep to business-only.

## Decisions

New records to create (proposed at plan approval, accepted via S1; slugs
final at creation):
- `0124-bounded-durable-card-delivery` — amends 0117; bounded delivery +
  defined recovery replaces accepted lost/duplicate cards.
- `0125-host-only-template-amendment` — amends 0122+0123; host-compiled,
  human-approved; identity = canonical proposedTemplates; durable
  approve→resume intent (closes D-0057).
- `0126-typed-terminal-denial-event` — amends 0115 scope; extended
  JOB_TOOL_DENIED contract, required append, event idempotency primitive.
- `0127-tagged-setup-action-model` — the action union, strict parser,
  wire schema, migration semantics.
- `0128-permission-approval-result` — typed delivery-failure union across
  all channels; delivery failure is never a denial.
Rejected simpler shapes are recorded inside each (e.g. SQL unblock, prompt
band-aid, telegram-only ports, single-axis projection) — all were
validated as incorrect during the 15 passes.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| runtime behavior | Changed | S2a/S3/S4 core: events, delivery, proposals |
| API | Changed | S2b wire union + setup.deliveryNotice; authored OpenAPI schema |
| data/schema | Changed | event idempotency column, prompt identity columns, outbound generation/checkpoint/cancelled, migrations |
| CLI/ops | Changed | action + deliveryNotice rendering via one shared formatter |
| UI | N-A | no UI surface exists for these areas today |
| docs | Changed | S1 amendments (0115/0117/0122/0123 + spec echoes), run-guidance block |
| tests | Changed | replaced-pins families (enumerated in the contract appendix) + story proofs + live gate |

settings.yaml: Unchanged by design — capability definitions live in
tool_catalog, never mirrored to settings (0122).

## Task Decomposition

Stories become roadmap-linked build waves; exact task contracts are
authored just-in-time per WORKFLOW.md. Initial capability-level cut:
- S1: one docs task (amendments + appendix + spec updates).
- S2a: producers+append task; read-seams task (finalization/status/
  visibility); access-preflight rerouting task.
- S2b: domain+parser+formatter task; wire/OpenAPI/SDK/CLI/MCP task;
  migration task.
- S3: schema+atomic-preparation task; dispatch/checkpoint/settlement task;
  reconciler+expiry+deliveryNotice task; PermissionApprovalResult cutover
  task (adapters + consumers); delete/cancel + promotion-deletion task.
- S4: compiler+host-flow task; durable-intent + canonical_key migration
  task; guidance-block task.
- S5: live gate runbook (human-gated).
Every task declares its plan contracts from the appendix; review briefs
carry them (plan-aware autoreview).

## Risks

1. Shared-type blast radius (PermissionApprovalResult touches every
   interactive consumer) — mitigated by explicit per-caller branching,
   the enumerated consumer inventory, and story-level tests; watched
   closely in autoreview.
2. Migrations (setup_state total migration; canonical_key rekey) — offline,
   deterministic, snapshot-tested against the evidence-gate forensic
   capture; 0112 migrate-once.
3. Cross-adapter regression — pinned Slack routing test retained; all four
   prepared-send ports in scope precisely to avoid the telegram-only
   regression.
4. Event-before-finalization reordering — validated against the real
   epilogue; append failure path proven to reach the retry branch.
5. Live-gate flakiness — fault matrix scripted; each kill point maps to a
   real code boundary.

## Verify Plan

- Per task: `python3 factory/scripts/verify.py` (green before review);
  implementer-recorded tests per task contract.
- Per stage: local autoreview of the uncommitted diff with the task's
  contract slice as review context; per-contract verdicts
  (implemented/partial/missing) — missing/partial blocks.
- Story closeout: branch-wide autoreview with the full contract appendix.
- Epic closeout: S5 live gate on the real KnackLabs job + crash/restart
  fault matrix; prompt sweep last, owner-approved.
- `python3 factory/scripts/check_dual_runtime.py` stays green throughout.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-13: S2a provenance_lane uses the existing AgentEngine vocabulary plus host (anthropic_sdk | deepagents | host, imported from shared/agent-engine.ts constants) instead of the plan's literal anthropic - reusing the single sanctioned SDK-engine literal keeps the provider-boundary architecture gate count-exact with no exception record
- 2026-08-13: S2b narrows persisted approve_grant blockers at the storage boundary to addRules-without-destination (the only variant the setup approval path executes); decision 0127's additions-or-replacements wording covers the domain union, not persisted setup state
- 2026-08-13: Prepared permission-card send ports perform local validation before returning a one-shot provider-call closure, so the recovery flow can persist beginSend immediately before invoking the provider API.
- 2026-08-14: Job deletion records the same structured cancellation reason { code: 'job_deleted', job_id: <job id> } on the pending interaction, delivery item, and delivery audit rows.
- 2026-08-14: S4-COMPILER keeps host capability-template proposals dormant with a code-owned false constant in the capability_run host handler; S4-INTENT will activate that same gate atomically without adding a settings or API surface.
