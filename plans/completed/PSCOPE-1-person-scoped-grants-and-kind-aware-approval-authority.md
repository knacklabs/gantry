---
issue: PSCOPE-1
title: Person-scoped grants and kind-aware approval authority
status: approved
saved: 2026-08-09T16:38:34+00:00
story: PSCOPE-1
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
---

# PSCOPE-1 — Person-scoped grants and kind-aware approval authority

## Problem

Approval authority and grant scope don't match how people use the bot, and they aren't
uniform across providers. `isControlApproverAllowed` runs the same per-conversation
control-approver allowlist for every conversation, so a person in their own 1:1 DM can't
approve their own agent's tool requests unless pre-listed — and an empty allowlist (the
fresh-chat default) makes the setup card's grant button a dead end. Durable grants
(`agent_tool_bindings`) are keyed by `(appId, agentId, toolId)` with no person dimension,
and provider DMs commonly share one configured agent folder, so a durable grant approved in
one DM silently widens the shared assistant's access for every other DM and group on that
agent. Personal memory is already isolated per person in DMs via the shipped `personId`
model, but approval authority and grants never followed that boundary. Group onboarding can
only cold-start on Telegram and even there can't mint a first approver.

## Scope / Non-goals

In scope: kind-aware approval authority (DM = the DM's user; group = allowlist); per-person
grant scoping on `personId` (nullable column, `null` = shared); acting identity that inherits
creation context; a self-grant eligibility gate; and a provider-neutral group installer
auto-seed with in-group acknowledgement.

Non-goals (deferred D-0054, org tier): organisation roles, an admin-controlled org-policy
grantable catalog, manager/IT approval routing, a team/company memory-brain hierarchy,
person-scoped *credentials*, and alias-verification gating. This story only builds the three
seams those extend. Also non-goal: forking a separate agent/persona/memory per DM (refuted —
memory is already person-isolated; decision 0118).

## Acceptance Criteria

1. In a 1:1 DM the DM's own user can approve a setup/permission card with no allowlist entry;
   a non-participant cannot. Groups still require an allowlisted approver (unchanged).
2. A durable grant approved in Alice's DM is used only when the agent acts for Alice — never
   for Bob's DM or a group on the same agent. Existing grants keep applying as shared.
3. A job created in a DM uses that person's grants at run time; a job created in a group uses
   shared grants. The scope a setup-card grant lands in is the scope the job runs in.
4. A durable DM self-grant is permitted only for a personal-memory-eligible person; an
   ineligible person may approve for the current run only.
5. Installing the bot into a new group by a recognised person seeds that person as the first
   approver with an in-group acknowledgement, on every provider where the installer is
   identifiable; elsewhere it degrades to manual with a clear in-group message.
6. Behaviour is uniform across providers; no per-provider approval logic is added. No
   regression for existing shared grants or group approvals.

## Technical Approach

The isolation axis is the existing `personId` (resolved at message time by
`resolveCanonicalMemoryPersonId`; only DMs mint a person). We add a person dimension to
grants and branch the authority check on `conversationKind`; we do not fork agents.

- **Authority (AC1):** branch `ConversationAdministrationService.isControlApproverAllowed` on
  `conversationKind`. DM → authorize iff the clicker is the DM's counterpart participant
  (computed, no allowlist row); group/channel → the existing allowlist path. All shared
  guards (membership, same-channel, reserved-decider/PERM-2) stay. Approver resolution is
  kept as one replaceable function so the org tier can later add manager/IT routing (seam 1).
- **Grant model (AC2, AC3):** add nullable `personId` to `agent_tool_bindings` behind the
  canonical Drizzle repository (no raw SQL drift — lesson canonical-postgres-cutover). Binding
  id includes `personId`; `null` = shared. `resolveAgentToolRuntimePolicy` reads
  `shared ∪ person(P)` when an acting `personId` is present, `shared` otherwise. Existing rows
  are `null` (one-directional, no backcompat — 0112/0113). This column is seam 2 (org later
  subdivides `null`).
- **Acting identity (AC3):** thread an acting `personId` into the tool-policy/execution
  context. Live DM turn = the resolved `personId`. Jobs persist their acting `personId` at
  creation from the creation context (DM → creator's person; group → `null`/shared) and pass
  it at run time. Authorization still runs deterministically before any grant (lesson
  permission-safety).
- **Self-grant gate (AC4):** in the durable-grant path, when the request originates in a DM,
  permit the permanent write only if the acting person is personal-memory-eligible (reuse the
  `memoryHydrationEligible` signal); otherwise downgrade to allow-once. This is seam 3.
- **Group bootstrap (AC5):** generalise the Telegram group-join onboarding into a
  provider-neutral step behind an adapter (lesson architecture-boundaries): on bot-added-to-
  group, if the installer resolves to a recognised `personId`, seed them as the first approver
  (`replaceConversationApprovers`) and post an in-group acknowledgement; unknown installer →
  manual message, seed nobody. Provider-specific installer-id extraction is the only
  per-provider input, isolated per channel; Telegram/Slack supply it, Discord/Teams fall back.

Rejected simpler/other approaches (recorded as decisions): (a) fork an agent per DM — refuted,
memory is already person-isolated, would fork brain/routing + need a migration (0118); (b)
session-only DM approval with no durable person scope — rejected, breaks the setup-card grant
for DM-created jobs; (c) leaving grants agent-global — rejected, that is the leak.

## Decisions

- `docs/decisions/0118-identity-scoped-approval-and-grants.md` — kind-aware approval,
  per-person grants (`null`=shared), acting identity inherits creation context, self-grant
  eligibility gate; refutes the agent-fork.
- `docs/decisions/0119-provider-neutral-group-approver-bootstrap.md` — provider-neutral
  installer auto-seed for a group's first approver, manual fallback.
- Deferral `D-0054` — the organisation governance tier, with revisit triggers.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | DM approval without allowlist; person-scoped grant resolution; acting-identity threading; group installer auto-seed + in-group ack |
| Data/schema | Changed | nullable `personId` on `agent_tool_bindings` (canonical Drizzle), binding-id keying; migration sets existing rows to `null` (shared) |
| API/CLI | Unchanged by design | approver CLI/API (`gantry conversation approvers`, `PUT .../approvers`) still governs groups; no new surface needed for DM self-authority or person grants |
| UI | Unchanged by design | setup/permission cards render as today; only who-can-act and grant scope change |
| Docs | Changed | decisions 0118/0119; architecture map note for the grant scope + approver seams |
| Tests | Changed | repository tests for the schema change (lesson schema-storage); authority-branch and policy-resolution unit tests; onboarding/bootstrap tests |

## Task Decomposition

1. **PSCOPE-1-1 — Kind-aware approval authority.** Branch `isControlApproverAllowed` on
   `conversationKind`; DM counterpart-participant check; groups unchanged; keep approver
   resolution as one seam. Falsifier: DM participant approves with no allowlist row; non-
   participant denied; group still allowlist-gated. (AC1)
2. **PSCOPE-1-2 — Person-scoped grant model.** Nullable `personId` on `agent_tool_bindings`
   (Drizzle + repository), binding-id keying, migration → `null`; `resolveAgentToolRuntime
   Policy` merges `shared ∪ person(P)`. Falsifier: a `personId` grant applies only for that
   person; existing rows still apply as shared. (AC2)
3. **PSCOPE-1-3 — Acting-identity propagation.** Thread acting `personId` into the tool-policy
   context; persist a job's acting `personId` at creation from creation context; DM live turn
   uses resolved person. Falsifier: DM-created job uses creator's grant; group-created uses
   shared. (AC3)
4. **PSCOPE-1-4 — DM self-grant eligibility gate.** Durable DM self-grant requires
   `memoryHydrationEligible`; else allow-once. Falsifier: eligible person's future-grant
   persists; ineligible person's does not (allow-once only). (AC4)
5. **PSCOPE-1-5 — Provider-neutral installer auto-seed + in-group ack** *(separately
   shippable)*. Generalise Telegram onboarding behind an adapter; seed recognised installer,
   in-group acknowledgement, manual fallback. Falsifier: recognised installer becomes approver
   with an in-group message; unknown installer seeds nobody and says how to set one. (AC5)

Tasks 1–4 land as one PR (the authority+grant foundation); task 5 ships as its own PR.

## Risks

- **Schema/repository drift** (lessons schema-storage, canonical-postgres-cutover): the
  `personId` column must go through the canonical Drizzle repository with repository tests and
  an architecture-map/docs update, not raw SQL. Mitigation: task 2 includes repository tests.
- **Acting-identity gaps:** if a code path resolves grants without threading `personId`, a DM
  person's grant silently won't apply (fail-closed — safe, but a usability miss). Mitigation:
  centralise the acting-identity read in the policy resolver; test the job and live-turn paths.
- **Recurring class tripwire — delivery-semantics @ jobs/execution-readiness (x3, SETUPRACE-1):**
  task 5's in-group acknowledgement posts a message. This plan does NOT re-open notification
  delivery hardening. If review flags a `delivery-semantics` issue on the ack path, escalate
  per WORKFLOW.md Recurring Findings (consolidate/defer) — do not silently patch it again.
- **Provider installer-id variance:** Discord/Teams may not identify the installer; auto-seed
  degrades to manual. Accepted; authority parity is unaffected.
- **PERM-2:** identity scoping decides whose grant applies, not who may grant; durable writes
  still require a human decision. Mitigation: gate + authority tests assert no worker self-grant.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts \
  apps/core/test/unit/application/provider-conversations \
  apps/core/test/unit/application/permissions \
  apps/core/test/unit/application/agents \
  apps/core/test/unit/adapters/storage/postgres \
  apps/core/test/unit/channels apps/core/test/unit/runtime
python3 factory/scripts/verify.py
```
Postgres-backed repository/integration suites for the `agent_tool_bindings` change run in CI
(schema `gantry`). Functional check applies where a card's who-can-approve / grant scope is
user-visible.
