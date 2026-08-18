---
issue: PREFLIGHT-1
title: Scheduled jobs provision tools upfront (prime discovery) + grantable setup cards
status: approved
saved: 2026-08-09T04:31:43+00:00
story: PREFLIGHT-1
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
---

# PREFLIGHT-1 — Scheduled jobs declare their tools upfront (neutral) + grantable setup cards

> Revised after a read-only Codex critique (stage PREFLIGHT-1-1): Part A is a bug reconciliation with no new decision and no durable-policy change; Part B is reworked to a single-event, application-owned notification port wired from both Control and IPC composition and dispatched asynchronously; Part C tests the compiled prompt; one decision, not two; the story is user-facing.

## Problem

A scheduled job runs as its agent and inherits the agent's granted tools, but nothing captures the tools the *task* will need. `access_requirements` is optional and almost always omitted (becomes `[]`), so creation-time readiness trivially passes even when the task will need a tool the agent lacks; the gap is discovered only when a scheduled run hits the tool and pauses. Worse, when that pause fires for a builtin facade tool (WebSearch, WebRead, FileRead, Browser, FileWrite, FileEdit), the "Setup needed" card is instruction-only — **no grant button** — because `autonomousGrantRecovery` drops canonical facade tools into the "exact tool grants are not accepted" fallback, contradicting the durable-access policy that already accepts those exact facade rules. Verified live and in code across both runner lanes.

## Scope / Non-goals

In scope (three neutral, reuse-only parts):
- **A. Grantable facade tools:** bring `autonomousGrantRecovery` into compliance with the existing durable-access policy so builtin facade tools become one-tap grantable on setup cards, via the shared recovery function (both lanes).
- **B. Upfront actionable card:** job creation surfaces the actionable setup card when readiness finds a missing declared tool, via a single-event, application-owned notification port dispatched asynchronously — so gaps surface shortly after creation, not at the first scheduled run, without slowing creation.
- **C. Declare-at-creation (prompt-based, neutral):** the creating agent populates `access_requirements` when scheduling a job, so the existing readiness pipeline catches gaps upfront. Both lanes.

Non-goals / explicitly rejected: **prime auto-discovery is rejected** — Anthropic-lane-only (DeepAgents has no record-without-execute mode; `runMode:'prime'` there would execute tools for real at creation), half-wired to the host, and duplicative of the dead `JobPrimingService` + the existing requirements pipeline (0112/0113). No worker/agent self-grant (PERM-2). No change to the runtime pause/denial path — it stays the fallback for under-declared tools and run-time-only checks (worker image, browser launch, fleet). No third-party-MCP one-tap (0020); no locked-preset/fixed-image grantability. No new access-requirement shape. No durable-access-policy change (it already accepts facade rules). Deleting the dead `JobPrimingService` is separate cleanup, not folded in.

## Acceptance Criteria

1. A scheduled pause on an ungranted builtin facade tool shows a one-tap "Allow for future" button on the setup card, on **both** lanes; tapping durably grants the *canonical* selection (FileRead/WebRead/Browser, never the raw SDK alias) and appends the canonical job requirement. Ungranted third-party MCP / locked / fixed-image stay instruction-only. The existing projected-`browser.use` branch is preserved.
2. When an agent schedules a job whose task needs a tool the agent lacks, it declares that tool in `access_requirements`, and the owner gets an actionable setup card shortly after creation (not only at the first scheduled run). Creation stays silent and fast — the notification is dispatched asynchronously, not awaited in the create path.
3. A job whose declared tools are all already granted is `ready` and runs with no pause or card.
4. **Exactly one** `JOB_SETUP_REQUIRED` event per blocker fingerprint at creation (no double-publish); the creation card and any later runtime pause for the same blocker are deduped by the existing `notified_fingerprint` (negative-control test proves no second prompt/card).
5. Neutral: A, B, and C behave identically regardless of runner lane. No `runMode`/prime code is added. No architecture-layer violation (application does not import the runtime `jobs` layer; notification crosses via an application-owned port wired in runtime composition).
6. PERM-2 preserved: the agent only declares; durable authority is written only after a user-permanent host decision. Runtime pause remains the fallback.

## Technical Approach

**Part A (one shared function; bug reconciliation).** In `autonomousGrantRecovery` (`apps/core/src/shared/tool-execution-policy-service.ts`), **keep the existing projected-`browser.use` branch (~:599) first** (canonicalization alone does not cover projected browser MCP names), then, before the "exact tool grants are not accepted" fallback (~:617), canonicalize with `publicGantryToolNameForSdkTool` and, if the canonical name satisfies `isGantryFacadeExactToolRule`, emit `request_access {kind:tool, name:<canonical>}` (the same shape already used for durable Gantry tools and already accepted by `durable-access-policy.ts:151`). Both lanes reach this via `autonomousToolRecoveryAction`/`evaluate`; grantability comes from the shared `isGrantableAutonomousToolRecovery`. **No durable-access-policy change; no new decision** (this brings recovery into line with existing policy + existing operating guidance that already instructs `request_access kind:tool` for exact facades). Downstream (button eligibility `setup-pause-permission-prompt.ts:309`, grant application `pending-interaction-permission-recovery.ts:93`, requirement append `setup-pause-permission-wiring.ts:202`) is unchanged.

**Part B (single-event, application-owned port, async).** Creation already computes readiness and calls `recordJobSetupRequired` (which publishes `JOB_SETUP_REQUIRED`). Do **not** also call `notifyJobSetupRequired` (it independently publishes the same event → double-fire, and it lives in the runtime `jobs` layer which the application layer may not import). Instead: introduce an **application-owned notification port** (a callback on the job-management deps) that, when readiness is blocked at creation, dispatches the actionable setup-pause prompt **once** and publishes **exactly one** event (give the notifier a no-event mode, or route the single event through the port). Wire this port in **runtime composition** for **both** creation entry points — the Control route and the agent/IPC path constructed in `apps/core/src/jobs/ipc-scheduler-create-handlers.ts` (both must be wired or the agent-created-job path is unwired). Dispatch **asynchronously** (fire-and-forget on a durable/outbox-style seam, not awaited) so channel-delivery latency never slows job creation. The existing `notified_fingerprint` dedup then prevents a second card when the first scheduled run later pauses for the same blocker.

**Part C (prompt-based declaration, neutral).** Strengthen the `access_requirements` guidance on the `scheduler_upsert_job` MCP tool (`apps/core/src/runner/mcp/tools/scheduler.ts`) and add a line to the agent operating guidance (`OPERATING_GUIDANCE_BLOCK` in `apps/core/src/application/agents/prompt-profile-service.ts`, which is compiled into the full-access prompt and consumed by both lanes) instructing the agent to declare the task's tools at creation, preferring semantic-capability IDs (0109). Feeds the existing `normalizeAccessRequirements` → `evaluateJobReadiness` pipeline. Test the **compiled** `PromptProfileService` output for a full-access job-creating agent (prove the instruction is live, not dead text).

**Runtime fallback unchanged:** `pauseJobForSetupIfNeeded` → `notifyJobSetupRequired` still catches under-declared tools and run-time-only checks.

## Decisions

- **One new decision — Scheduled jobs declare their tool requirements at creation (prompt-based); prime auto-discovery rejected.** The creating agent declares `access_requirements`; readiness surfaces gaps via a single-event, asynchronously-dispatched actionable upfront card; the runtime pause is the fallback. Record the rejected alternative: prime-based auto-discovery is non-neutral (Anthropic-only; DeepAgents would execute tools for real), half-wired, and duplicative — revisit only if a neutral DeepAgents record-without-execute mode is built. Note the dead `JobPrimingService` as separate cleanup.
- **Part A takes no new decision** — it reconciles `autonomousGrantRecovery` with the existing durable-access policy (which already accepts exact facade tools) and existing operating guidance.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | facade-tool grants become actionable; single actionable card at creation |
| Data/schema | Unchanged | reuses `access_requirements` + `setup_state` |
| API/CLI | Changed (additive) | application-owned notification port on job-management deps; reuses existing scheduler arg |
| UI | Changed (native buttons/notification) | setup card gains a button for facade tools; provider-native, no custom visual UI |
| Docs | Changed | one new decision; agent guidance/tool-description copy |
| Tests | Changed | grantability; single-event creation card + later-pause negative control; compiled-guidance |

## Task Decomposition

**user_facing: true** — the button and card timing are user-observable behavior; the functional check must run (verified via the live test). Native provider buttons need no custom visual design.

1. **PREFLIGHT-1-2 — Grantable builtin facade tools on setup cards (Part A).** `autonomousGrantRecovery`: preserve the projected-browser branch, then emit `request_access kind:tool` for canonical facade tools. No durable-policy change. Both lanes. Tests: `tool-execution-policy-service.test.ts` (facade tools grantable; third-party MCP + locked non-grantable; browser branch intact) and `setup-pause-prompt.test.ts` (facade blocker → "Allow for future" + appends canonical requirement). Independent.
2. **PREFLIGHT-1-3 — Single-event async actionable card at job creation (Part B).** Application-owned notification port; dispatch one actionable card + exactly one event at creation on a readiness blocker; wire from Control + `ipc-scheduler-create-handlers.ts`; async (not awaited); rely on fingerprint dedup. Tests: creation card fires once; single event per blocker; later runtime pause with the same blocker → no second card; creation not slowed. Independent.
3. **PREFLIGHT-1-4 — Declare-at-creation guidance (Part C).** Strengthen `scheduler_upsert_job` guidance + operating-guidance line; assert the **compiled** prompt for a job-creating agent carries the instruction. Depends on Part B for the upfront-card payoff.

## Risks

- **Under-declaration (agent mispredicts tools)** → soft; the runtime button (Part A) + runtime pause remain the fallback.
- **Double event / double card** → resolved by the single-event port + `notified_fingerprint` dedup; proven by a negative-control test.
- **Layering** → application-owned port wired in runtime composition; application never imports the runtime `jobs` layer (keeps `check_architecture` green).
- **Creation latency** → async dispatch, never awaited in the create path.
- **Over-granting via one-tap write tools (FileWrite/FileEdit)** → risk label on the card + explicit human approval + durable-access policy still gates persistability.
- **Neutrality** → all three parts are shared-path or shared compiled-prompt; nothing lane-specific.

## Verify Plan

```
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/shared apps/core/test/unit/application apps/core/test/unit/jobs apps/core/test/unit/runner
python3 factory/scripts/verify.py
```
Then LIVE (real acceptance): build + `gantry restart`; (a) drop a facade tool (e.g. WebSearch) from a test agent, trigger a run → the setup card shows a one-tap button → approve → tool grants + run resumes; (b) ask the agent to schedule a job whose task needs an ungranted tool → it declares the requirement and a single actionable card arrives shortly after creation (creation not slowed); (c) schedule a job needing only granted tools → `ready`, no card; (d) force a later runtime pause for the same blocker → no second card. Whole-branch autoreview until clean; functional check for the user-facing card/button.
