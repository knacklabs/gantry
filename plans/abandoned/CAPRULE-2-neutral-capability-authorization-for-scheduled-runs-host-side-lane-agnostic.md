---
issue: CAPRULE-2
title: Neutral capability authorization for scheduled runs (host-side, lane-agnostic)
status: approved
saved: 2026-08-08T18:38:15+00:00
story: CAPRULE-2
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

# CAPRULE-2 — RunCommand authorization defers to the host reviewed policy (lane-agnostic); revert wrong CAPRULE-1 handoff

## Problem

CAPRULE-1 (#396) was wrong: its capability fix lived in the anthropic-SDK worker lane only and its unit tests MOCKED the host as approving. Live on the KnackLabs job the exact `gog sheets get` command is still denied (terminal, "did not match any scoped autonomous rule") and the job pauses.

Live root cause — CONFIRMED against the running runtime (Postgres + dist), not assumed:
- `capability:google.sheets.values.get` is an ACTIVE agent binding, builtin, `local_cli`, executable `/opt/homebrew/bin/gog` with matching hash+version. (Skill-activation gate and stale-binary are RULED OUT.)
- It projects to exactly `RunCommand(/opt/homebrew/bin/gog sheets get *)` (computed from the live capability def), and that rule MATCHES the real command (`evaluateAutonomousToolUse → allowed:true`). The projection and matcher are correct.
- In the live run, MCP tools (`todo_update`, `mcp_call_tool`) were authorized via the HOST (`decidedBy: reviewed_rule`), but the `gog` RunCommand went straight to a terminal deny with NO host consult. The capability's projected rule lives in the HOST's reviewed policy (`policy.rules` from `resolveAgentToolRuntimePolicy`), but the RunCommand/Bash authorization path evaluated against a worker-side autonomous rule set that excludes it and denied WITHOUT asking the host.

So: MCP tools ask the host; RunCommand does not. That asymmetry is the bug, and it is lane-independent.

## Scope / Non-goals

In scope: (a) make the RunCommand/Bash authorization path defer to the host reviewed policy — the same authorization the MCP path already uses — on a worker-local miss, in BOTH the DeepAgents and Anthropic-SDK lanes (neutral); (b) revert CAPRULE-1's anthropic-only handoff + its mocked-host tests + the line-budget bump + decision 0116.

Non-goals: NOT feeding the host-reviewed rules into the worker's autonomous set (option b — rejected: it pushes host authority into the worker, closer to what PERM-2 forbids). No changes to the matcher, the capability projection (verified correct), or CAPRULE-1 Part B (notifications — independent, stays on main). No worker self-grant (PERM-2 preserved).

## Acceptance Criteria

1. A scheduled run's RunCommand that a job-declared reviewed capability authorizes (e.g. `gog sheets get`) is allowed via the host reviewed decision — identically on the DeepAgents and Anthropic-SDK lanes.
2. LIVE proof (the real acceptance, not a mocked unit test): after build + `gantry restart`, resuming the KnackLabs job runs the `gog sheets get` read instead of pausing.
3. An ungranted/undeclared RunCommand still denies (host denies too); MCP + Browser paths unchanged; PERM-2 boundary intact.
4. CAPRULE-1 Part A reverted; Part B (notifications) untouched.

## Technical Approach

On a scheduled RunCommand/Bash worker-local MISS, consult the host reviewed decision (`reviewedRuleDecision` in `apps/core/src/runtime/ipc-permission-classifier-decision.ts:121`, which builds `policy.rules` via `resolveAgentToolRuntimePolicy` + passes `semanticCapabilityDefinitions`) before the deny becomes terminal — exactly as the MCP tool path already does. If the host authorizes, run; else terminal. The worker's `currentAutonomousAllowedToolRules()` is NOT widened (PERM-2 preserved). This must be wired NEUTRALLY at the seam each lane's RunCommand path uses:
- Anthropic lane: the scheduled branch of `tool-permission-gate.ts` (its RunCommand/Bash worker evaluation).
- DeepAgents lane: `gantry-shell-tool.ts` (why its RunCommand did NOT reach the host in the live run must be pinned first — the validation task does this).

Because the host's `policy.rules` already contains the correct projected rule (verified), "ask the host" resolves to allow. The exact per-lane seam where RunCommand currently bypasses the host is pinned by CAPRULE-2-1 (live trace) BEFORE any code.

## Decisions

- New decision (CAPRULE-2): RunCommand authorization is host-authoritative and lane-neutral, mirroring the MCP path; the worker never self-grants. Supersedes/deletes 0116 (the anthropic-only handoff) on the Part A revert.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | scheduled RunCommand authorizes via the host reviewed policy, lane-agnostically; anthropic Part A reverted |
| Data/schema | Unchanged | reuses existing policy/definition plumbing |
| API/CLI | Unchanged | none |
| UI | Unchanged | Part B notification stays |
| Docs | Changed | new decision; delete 0116 |
| Tests | Changed | revert Part A mocked-host tests; add tests that assert the RunCommand path consults the host (with a REAL host decision fixture), plus the live resume as the true acceptance |

## Task Decomposition

1. **CAPRULE-2-1 (read-only, Codex via `forge delegate --read-only`)** — validate the plan/approach: confirm (with the live-verified evidence) that the RunCommand/Bash path denies without consulting the host while MCP does, pin the EXACT per-lane seam (anthropic `tool-permission-gate.ts` scheduled RunCommand branch; DeepAgents `gantry-shell-tool.ts`) where RunCommand bypasses the host, and confirm option (a) (defer-to-host on miss, no worker-set widening) is the smallest neutral PERM-2-safe fix. No code.
2. **CAPRULE-2-2** — revert CAPRULE-1 Part A and implement option (a) at both pinned seams so a job-declared reviewed capability's RunCommand authorizes via the host, lane-agnostically; keep Part B. Falsifier: a scheduled RunCommand the host authorizes is allowed (REAL host fixture) on both lanes; ungranted denies. Live: resume the KnackLabs job → gog runs.

## Risks

- Deferring RunCommand to the host adds a host round-trip on a miss (the MCP path already does this) — acceptable.
- The DeepAgents RunCommand path already appears to call the host IPC, yet the live run denied without a host consult; the exact reason MUST be pinned by CAPRULE-2-1 before code, or the fix targets the wrong seam (the CAPRULE-1 mistake).
- Reverting Part A must not disturb Part B — revert only the Part A files.

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runner apps/core/test/unit/shared apps/core/test/unit/application
python3 factory/scripts/verify.py
```
Then LIVE (the real acceptance): build + `gantry restart` + `gantry jobs resume job-knacklabs-lead-maintenance-…` → confirm the `gog sheets get` read RUNS (no pause), watching events for a host `reviewed_rule` allow on the RunCommand.
