---
issue: CAPRULE-1
title: Scheduled runs drop capability-backed RunCommand rules from the autonomous allowlist
status: approved
saved: 2026-08-08T13:55:06+00:00
story: CAPRULE-1
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

# CAPRULE-1 — Scheduled runs use granted capability-backed commands; pause with one clear message

## Problem

Observed live on the real **KnackLabs Lead Maintenance** scheduled job after the restart:

1. **The job can't do its work.** Its agent ran `gog sheets get <sheet> "Bot Recommendation!A1800:K2000" --account ravi@…` — granted two ways (the `google.sheets.values.get` capability **and** the concrete `RunCommand(/opt/homebrew/bin/gog sheets get *)` rule) — and it was denied *"not on the autonomous run allowlist."* The job pauses and never completes.
2. **The pause spams three messages.** One denied tool produces three overlapping Telegram messages — a jargon-heavy "🛠️ Setup needed" card plus the terminal "I couldn't finish this job" card rendered **twice** ("Needs permission") — none actionable.

Verified problem 1 is **not** the rule matcher: `evaluateAutonomousToolUse` with that exact rule + command returns `allowed=true`. The granted authority never reaches the scheduled evaluator.

## Scope / Non-goals

In scope: (A) deliver the agent's **host-reviewed** capability + command authority (with semantic-capability definitions) to the scheduled permission decision so declared work runs; (B) collapse a denied-tool pause to one plain-language notification (+ one-tap approve when grantable).

Non-goals: no changes to the rule matcher, `resolveCapabilityRules`, or the semantic-capability projection (all verified correct). No weakening of the PERM-2 worker/host authority boundary — authority stays host-reviewed, never worker-self-granted. No new permission/capability type. Not touching the interactive path (already correct).

## Acceptance Criteria

1. A scheduled run whose agent is granted a semantic capability (with its reviewed definition) can invoke that capability's command without denial.
2. An *ungranted* capability/command still denies with a legible reason (no over-grant).
3. Canonical capabilities (Browser, etc.) keep working — regression held.
4. One denied-tool pause emits exactly **one** user-facing notification — no duplicate terminal card — in mobile-first plain language.
5. When the denial is genuinely grantable, the single message carries a one-tap approve; when not, it is a legible instruction (no dead-end duplicate).
6. PERM-2 invariant preserved: the worker never self-grants from its own configured `allowedTools`; capability authority is host-reviewed.

## Technical Approach

Verified by two read-only explorations. Root cause: the scheduled autonomous rule set `currentAutonomousAllowedToolRules()` (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts:123-131`) excludes the agent's durable capability/command grants by design (PERM-2 Task F, `:108-115`), and the scheduled `evaluate` (`:396-400`) omits `semanticCapabilityDefinitions` → `resolveCapabilityRules(rules, undefined)` (`apps/core/src/shared/tool-execution-capability-resolution.ts:41-63`) drops every `capability:<id>`. Browser survived via the canonical short-circuit (`apps/core/src/shared/tool-rule-matcher.ts:286-291`) that needs neither the grant nor definitions. The host IPC path already threads both correctly (`apps/core/src/runtime/ipc-permission-classifier-decision.ts:121-158`); `main_agent` harness is `auto` and this run used DeepAgents-style tools, so the deny may instead be a host-side projection gap (identity mismatch `ipc-permission-classifier-decision.ts:126-128`, or the skill-activation gate `agent-tool-runtime-rules.ts:157-162`). The exact lane is resolved by the read-only Codex validation before any Part-A code.

**Part A (the bug):** route the scheduled decision through the same host-reviewed capability authority the host/interactive paths already compute — include the agent's reviewed durable capability + command rules (`resolveAgentToolRuntimePolicy` / `policy.rules`) and pass the already-resolved `semanticCapabilityDefinitions` into the scheduled `evaluate`, at the validated boundary. Result: `gog sheets get` matches its rule and runs; the pause disappears.

**Part B (the UX):** at the single choke point `notifySchedulerTerminalRunState` (`apps/core/src/jobs/execution-notifications.ts:361-405`), suppress the terminal card fully when the setup card owns the outcome — key on the existing `setupNotified` + `SETUP_REQUIRED_PAUSE_REASON` (drop the fragile denial re-parse) and stop the secondary `:397` send. The setup card is the single message, rewritten mobile-first in `apps/core/src/application/jobs/scheduler-setup-story.ts:32-70`. Grantable one-tap approve already flows via `grantableRequirementCandidates`.

## Decisions

- **0116 (new, if Part A touches the PERM-2 boundary):** how host-reviewed capability authority reaches scheduled runs without the worker self-granting from configured allowedTools. Recorded once the Codex validation pins the lane.
- Reuses: 0043 (classifier risk-only / host authority), 0058 (readonly scheduler birthright), 0106 (scheduled runs cannot self-mutate), 0109 (semantic-capability job dependencies), 0115 (autonomous tool denial terminal), and the PERM-2 worker/host split.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | scheduled runs can use granted capability-backed commands; one notification per pause |
| Data/schema | Unchanged | reuses existing rule/definition plumbing |
| API | Unchanged | none |
| CLI/ops | Unchanged | none |
| UI | Changed | provider chat: single plain-language pause message (+ approve when grantable) |
| Docs | Changed | decision 0116 (if recorded); spec |
| Tests | Changed | autonomous-eval capability test; single-notification test; repro guard |

## Task Decomposition

1. **CAPRULE-1-1 (read-only, Codex via `forge delegate --read-only`)** — validate the root cause: which lane gated this run (DeepAgents/host vs anthropic_sdk worker), whether the deny is the worker-side autonomous set (`tool-permission-gate.ts:123-131`) or a host-side projection gap (identity / skill-activation), and pin the exact fix boundary. Gate Part A on its verdict.
2. **CAPRULE-1-2 (Part A)** — deliver host-reviewed capability + command grants (with definitions) to the scheduled decision at the validated boundary; PERM-2-consistent. Falsifier: a scheduled run granted `google.sheets.values.get` runs `gog sheets get …` without denial; an ungranted capability still denies; Browser regression held.
3. **CAPRULE-1-3 (Part B)** — collapse pause notifications to one plain-language message (+ approve when grantable). Falsifier: one denied-tool pause emits exactly one user notification; no duplicate terminal card.

## Risks

- Part A touches the PERM-2 authority boundary; naively re-including worker grants would weaken it. Mitigation: authority stays host-reviewed; the Codex validation pins the correct lane before code; decision 0116 records the approach.
- The exact lane is unconfirmed until validation; building Part A before it risks fixing the wrong boundary. Mitigation: CAPRULE-1-1 is a hard gate.
- Notification suppression could over-suppress a genuinely distinct message. Mitigation: key only on `setupNotified` + `SETUP_REQUIRED_PAUSE_REASON`; falsifier asserts exactly one message.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/shared apps/core/test/unit/runner apps/core/test/unit/jobs
python3 factory/scripts/verify.py
```

Behavioral checks that must exist and fail with the change reverted:
1. A scheduled/autonomous evaluation authorizes `gog sheets get …` when the agent is granted `google.sheets.values.get` with its definition; an ungranted capability denies.
2. Browser and other canonical capabilities still allowed on a scheduled run.
3. One denied-tool pause produces exactly one user-facing notification (no duplicate terminal render).
4. Live end-to-end: after `gantry restart` with the fix, `gantry jobs resume job-knacklabs-lead-maintenance-…` runs the sheet read instead of pausing (or pauses exactly once, cleanly).
