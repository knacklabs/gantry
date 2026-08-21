---
issue: SCHED-6
title: Autonomous jobs pause-and-ask on tool denial instead of silently degrading
status: approved
saved: 2026-08-07T17:35:51+00:00
story: SCHED-6
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

# SCHED-6 — Autonomous jobs pause-and-ask on tool denial instead of silently degrading

## Problem

A scheduled (autonomous) job whose agent reaches for a tool it isn't granted does NOT ask the human. For the "non-promptable" denial class, `denyNonPromptableAutonomousRecovery` (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/autonomous-permission-recovery.ts:13`) returns `{ behavior: 'deny', interrupt: false, terminal: false }` — the model just gets "no" and is free to continue with a different tool (e.g. Browser) and finish the run "successfully". No pause, no approval prompt, no notification. It is even unit-tested as behaving "without pausing the job" (`tool-permission-gate.test.ts:1018`).

Consequence (Ravi's lived report): jobs never produced an approval prompt; they silently skipped the intended tool, did the work the wrong way with Browser, burned the run's time and tokens, and finished green — so there was no failure signal to investigate. This is the core time/token bleed.

This contradicts the stated design: `docs/architecture/autonomous-jobs.md:39` says an under-declared job that reaches a denied tool should PAUSE. Decision 0019 says access_requirements are preflight assertions, not "every declared tool must be used" — which does NOT authorize "denied tool → quietly substitute another." So the silent path is a gap, not endorsed behavior. (Verified by two independent Codex read-only passes.)

## Scope / Non-goals

In scope: stop autonomous-job tool denials from silently continuing. A denial routes into the EXISTING SCHED-4B terminal-denial → job-pause → setup-approval-card flow, so the human is asked (grantable) or told legibly (non-grantable).

Non-goals: a live synchronous "freeze this tool call mid-run and wait for the human, then resume the same call" — that needs a change to the autonomous zero-timeout runner/host protocol and is explicitly OUT. Pause-and-ask (job halts, asks, human approves, job re-runs) is the target. No config/settings changes. No new permission type (grants live on the agent; jobs inherit — confirmed).

## Acceptance Criteria

1. An autonomous-job tool denial NEVER results in silent continuation: it is terminal for the run.
2. A GRANTABLE denial (the human approving would unblock it) pauses the job and raises the SCHED-4B approval card naming the specific missing tool/capability — one tap to approve, then the job retries. For a DECLARED-but-ungranted tool the tap grants it to the agent; for an UNDER-DECLARED grantable tool the same tap ALSO adds it to the job's `access_requirements` (human-initiated, 0106-consistent), then the job retries.
3. A genuinely NON-grantable denial (locked-preset, fixed-image, protected path, unmatched command, unreachable mcp) ends the run with a LEGIBLE terminal outcome/card naming the tool and why it can't be granted — never silent, never a misleading generic error.
4. The card/outcome names the SPECIFIC denied tool/capability, not a generic message.
4a. A denied-tool terminal failure routes to the setup-pause (awaiting-approval) state and does NOT consume a retry/backoff attempt or count toward dead-letter — a job waiting for approval never dead-letters from waiting; a late grant (minutes or days) resumes it via recheck and it runs fresh.
5. Updated expectations for the tests that currently assert "denied without pausing"; new falsifiers for the grantable-pause and non-grantable-legible-fail endings.
6. The synchronous zero-timeout autonomous protocol is unchanged (no live wait); only the deny result's terminality + routing changes.

## Technical Approach

Verified by three Codex read-only passes. The fix is one seam plus routing that already exists.

**Timeout / late-grant behavior (verified — the run never waits for a human).** The autonomous permission timeout is zero (`permission-timeout.ts:5,8`), so a denial resolves immediately: the run ends, it does not block burning time/tokens waiting for approval. The setup-paused job has no expiry (no stale-cleanup found; consistent with 0053 no-timeout interactive), so it waits until approved or its needs change. A late grant is a late *retry*: the recheck resumes the job and it runs fresh from the start. Cost: the failed run's partial work is lost (approve-and-retry, not resume-the-exact-call) — the intended tradeoff. INVARIANT this change must preserve: a denied-tool terminal failure routes to the **setup-pause (awaiting-approval)** state and must NOT consume a retry/backoff attempt or count toward dead-letter — a job waiting for approval never dead-letters from waiting. (Codex D2/D4 indicates finalization already routes denied-tool → setup-pause, `execution-finalization.ts:174`; this pins it so it can't regress.)

**Core change — make the autonomous non-promptable denial terminal.** In `denyNonPromptableAutonomousRecovery` (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/autonomous-permission-recovery.ts:13-30`), return `interrupt: true` and emit terminal telemetry (`terminal: true`) instead of `{ behavior: 'deny', interrupt: false, terminal: false }` — mirroring the promptable-denial branch. That is the whole behavioral flip; it does NOT touch the synchronous zero-timeout permission protocol.

**Routing after that (all pre-existing, from SCHED-4B):**
- The retained terminal denial becomes the run error (`execution.ts:582`), which finalization turns into the denied-tool setup state + job pause + setup notification (`execution-finalization.ts:174-180`, `setupStateForDeniedTool` → `job-readiness-service.ts:394`).
- The denied tool's identity is already carried end to end: gate passes `toolName` (`tool-permission-gate.ts:418`) → recovery emits it (`autonomous-permission-recovery.ts:16`) → diagnostics retain it (`execution-diagnostics.ts:163`) → finalization names it in the blocker/label. So the card can say "missing: WebSearch," not a generic error (criterion 4).
- The card ENDING is already correctly branched by the SCHED-4B seam (`setup-pause-permission-prompt.ts:135/301`): a `missing_capability` blocker that maps to a stored `access_requirements` entry raises the one-tap approval card; everything else is an instruction-only card.

**Which ending each denial class lands on (Codex D1/D2):**
- Declared-but-ungranted grantable tool (Browser / scoped RunCommand / capability the job declared) → **one-tap approval card.** ✅ (Note: a *declared* requirement the agent lacks already fails at preflight, `execution-tool-access-requirements.ts:19` — this path is the mid-run under-declared case.)
- Under-declared but otherwise grantable tool (agent reached a tool NOT in the job's `access_requirements`) → today falls to **instruction-only** (no stored requirement to map). Legible + never silent, but not one-tap. **This is the design fork below.**
- Non-grantable (locked-preset, fixed-image, protected/dangerous path, unmatched RunCommand, unreachable MCP) → **instruction-only card naming the tool + why it can't be granted.** ✅ Correct as-is; a direct approval genuinely can't help these.

**Diagnostics:** `execution-diagnostics.ts:163` currently DISCARDS `permission_denied` events with `terminal:false`; once we emit terminal it retains them — confirm the tool name survives into the setup state.

**Blast radius (Codex D4):** the only caller is the scheduled-job branch (`tool-permission-gate.ts:418`); the soft-deny is depended on ONLY by tests that assert "denied without pausing" (`tool-permission-gate.test.ts:1018`, `execution-diagnostics.test.ts:35`) — deliberately updated here. No documented "optional probe may be denied and the job continues" flow exists; the architecture says it should pause (`autonomous-jobs.md:39`).

**Scope boundary:** pre-autonomous guards (protected-capability, memory-boundary, model-validation, wait-only, network — `tool-permission-gate.ts:155/299`) return their OWN non-terminal denials before the autonomous branch. They are genuinely non-grantable and a separate sweep; this change targets the confirmed silent-degradation seam only. A full "no autonomous guard ever soft-denies" sweep is noted as follow-up, not folded in.

**Under-declared grantable ending — RESOLVED (Ravi chose one-tap-adds-to-job):** when the denied tool is otherwise grantable but NOT in the job's `access_requirements`, synthesize the grantable requirement from the denied tool identity and present the SCHED-4B card with a single **Allow for future** action. Approving it performs BOTH, atomically from the human's decision: (a) adds the tool to this job's `access_requirements` (the job's declaration becomes honest), and (b) grants it to the agent (the durable agent-tool binding — the existing `persistRequestPermissionRules` path). Then the standard recheck resumes the job and it retries. This is a HUMAN-initiated job edit (the approver acting on the card), NOT the autonomous run mutating its own job, so it stays within 0106 (scheduled runs cannot self-mutate). The reused machinery is the SCHED-4B request-only review + persist + recheck chain; the new part is (1) mapping an under-declared denied tool to a grantable requirement suggestion and (2) the job-requirements add riding the same approval. Non-grantable under-declared tools still land on the instruction-only card.

## Decisions

One new decision — **0115-autonomous-tool-denial-terminal** (accepted): an autonomous-job tool denial is terminal — it never silently continues. This reverses the currently-tested soft-deny and pins the invariant the architecture already states (`autonomous-jobs.md:39`). Grantable → pause + approval card; non-grantable → legible terminal instruction card. Reuses 0019 (permission/job tool lifecycle), 0024 (locked preset), 0106 (no self-mutation), the SCHED-4B setup-pause machinery, and the autonomous lane.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | autonomous denial now terminal → job pauses/asks instead of silently continuing |
| Data/schema | Unchanged by design | reuses existing setup_state / diagnostics; no migration |
| API | Unchanged by design | none |
| CLI/ops | Unchanged by design | none |
| UI | Unchanged by design | provider chat surfaces only (existing SCHED-4B card) |
| Docs | Changed | decision record + autonomous-jobs.md alignment |
| Tests | Changed | flip the "denied without pausing" expectations; add grantable-pause + non-grantable-legible falsifiers |

## Task Decomposition

Two bounded tasks:

**SCHED-6-1 — terminal denial + correct card endings.**
- Flip `denyNonPromptableAutonomousRecovery` to terminal (`interrupt:true` + terminal telemetry).
- Confirm the terminal denial flows through `execution.ts:582` → `execution-finalization.ts:174` → the SCHED-4B card, carrying the denied tool name; adjust `execution-diagnostics.ts:163` retention so the tool name survives.
- Update `tool-permission-gate.test.ts:1018` and `execution-diagnostics.test.ts:35` to the terminal behavior; add falsifiers: (a) declared-but-ungranted grantable denial → approval card naming the tool → approve grants the agent → retry; (b) non-grantable denial (locked/fixed-image/protected/unmatched/mcp) → instruction-only card naming the tool.
- Record the decision (autonomous denial is terminal, never silent); align `autonomous-jobs.md`.

**SCHED-6-2 — one-tap approve-and-declare for under-declared grantable tools.**
- Map an under-declared denied tool to a grantable requirement suggestion (reuse the grantable-blocker mapping from `setup-pause-permission-prompt.ts` / `job-tool-access-requirements.ts`).
- The card's Allow-for-future approval, in one human action, adds the tool to the job's `access_requirements` AND grants it to the agent (`persistRequestPermissionRules`), then the existing recheck resumes + retries. Human-initiated → 0106-consistent.
- Falsifier: an under-declared grantable denial pauses, the card offers one-tap approve, approving both records the job requirement and the agent grant, and the job retries; a non-grantable under-declared tool stays instruction-only.

## Risks

- Terminal-on-denial changes autonomous-job behavior broadly; Codex confirmed no legitimate soft-deny-continue flow exists, but the verify step re-runs the full jobs/runner suites to catch any hidden dependency.
- Non-grantable denials must land on the legible instruction card, NOT a dead-end approval ask — the SCHED-4B seam already branches this correctly; the falsifiers pin it.
- A newly-terminal run is a *failed* run that pauses the job for approve-and-retry (not a live resume) — that's the intended UX, but it means the run's work up to the denial is lost; acceptable and legible vs today's silent-wrong-completion.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runner apps/core/test/unit/jobs apps/core/test/unit/application/jobs
python3 factory/scripts/verify.py
```

Behavioral checks that must exist and fail with the change reverted:
1. An autonomous job whose agent hits a non-promptable denied tool ends the run terminally and pauses the job — it does NOT return a soft-deny that lets the model continue with another tool.
2. A declared-but-ungranted grantable denial raises the SCHED-4B approval card naming the specific tool; approving it lets the job retry.
3. A non-grantable denial (locked/fixed-image/protected/unmatched-command/unreachable-mcp) ends with an instruction-only card naming the tool and why — never silent, never a misleading generic error.
4. An under-declared grantable denial pauses and shows a one-tap Allow-for-future card; approving it BOTH adds the tool to the job's `access_requirements` AND grants it to the agent, then the job retries (a non-grantable under-declared tool stays instruction-only).
5. A denied-tool pause does NOT consume a retry/backoff attempt or dead-letter the job — assert the run count / retry budget is untouched by an approval-pending pause, and a late approval resumes and reruns it.
6. Full jobs + runner suites stay green (blast-radius check).
