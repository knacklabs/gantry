---
issue: NOTIFY-1-T7
title: Deterministic structured job result from recorded run actions
status: approved
saved: 2026-08-21T11:05:44+00:00
story: NOTIFY-1-T7
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
---

# TOOLACT-1 — Universal neutral tool-activity + complete structured job result

## Problem
A scheduled job that uses non-capability tools (WebSearch, WebRead, RunCommand, file tools, MCP, delegation) produces an EMPTY structured result and falls back to raw narration: (a) the projection ignores generic tool phases, (b) neither worker runtime records a terminal per-tool success/failure event, and (c) the whole tool-activity signal is gated to scheduled jobs (`isScheduledJob`) even though it is a universal runtime signal useful for live-turn diagnostics, audit, and the observer.

## Scope / Non-goals
In scope: rename `JOB_TOOL_ACTIVITY`->`TOOL_ACTIVITY`, record a terminal outcome for EVERY tool call on both worker runtimes and both inline lanes for EVERY turn (live + job), a correlation-ID backbone, retention/pruning, and a neutral projection that turns a job's recorded actions into a structured result for any tool. Non-goals: itemizing a subagent's INNER tools into the parent job result (explicit "top-level tool calls only" contract); outstanding-call reconciliation on hard process death (accepted; the job terminal status conveys it).

## Acceptance Criteria
1. Every tool call on both runtimes and both inline lanes emits a terminal `TOOL_ACTIVITY` success/failure event with a stable per-invocation correlation id; live turns (jobId null) emit too.
2. The projection builds result.items neutrally from any tool (humanize label, outcome from ok), grouped by RAW semantic key with counts, failed-first, with a "+N more" overflow line, deterministic without DB ordering; no per-tool or per-provider code.
3. Capability/browser/denial dedup is correlation-id based, not name based: a generic event is suppressed only when an authoritative host event with the same id exists, else kept as fallback; a rich denial wins over its correlated generic failure.
4. `runtime_events` TOOL_ACTIVITY growth is bounded by retention; jobs keep full fidelity to completion.

## Technical Approach
Correlation-ID backbone: one `invocationId` (+ monotonic `seq`) allocated at tool START, carried to the terminal outcome, stamped on generic, capability_run, browser_action, and denial events. Anthropic id = `hookInput.tool_use_id || toolUseID`; inline id allocated in `start()` retained to `finish()`; deepagents id = LangGraph v2 `run_id`. Recording: anthropic worker emits from the matcher-less PostToolUse/PostToolUseFailure hooks using the FULL structural error classifier (`toolResponseIsError`); deepagents worker emits from `on_tool_end`/`on_tool_error` with `runtimeEventOnly:true` and generic structural ok-detection; inline `run()` records failure on error-shaped results, and the deepagents inline normalizer gets the same outcome callback so middleware/skill tools are covered. Streaming dedup: filter EACH streamed frame against the forwarded-key set (keyed incl. invocationId), not just the final pass. Projection: classify -> group by raw key -> order (failed first, then seq, tie-break raw key) -> bound with overflow + preserved count suffix; fix `humanizeTechnicalIdentifier` to split camelCase and retain the MCP tool suffix. Full detail in the task plan.

## Decisions
- Rename `JOB_TOOL_ACTIVITY`->`TOOL_ACTIVITY` and `JOB_TOOL_DENIED`->`TOOL_DENIED`, no backcompat alias (early-stage, decision 0003).
- Drop the `isScheduledJob` gates; tool-activity is a universal runtime signal, job notification is one consumer.
- Delegation: top-level tool calls only; subagent inner tools not itemized (explicit, tested).
- Hard-abort outstanding calls: accepted, not reconciled.

## Surface Impact
domain/events/runtime-event-types.ts (rename + refs); jobs/{status-formatting,execution,execution-diagnostics,browser-activity-events,ipc-capability-run-handler}.ts; adapters/llm/anthropic-claude-agent/runner/{query-loop,tool-permission-events,query-tool-success-ledger}.ts + inline-lane/index.ts; adapters/llm/deepagents-langchain/runner/{stream-normalizer,index,deep-agent-runner}.ts + inline-lane/index.ts; adapters/llm/inline-lane-tool-activity.ts; shared/user-visible-messages.ts; storage/postgres (retention); scripts/architecture-map.json (query-loop budget).

## Task Decomposition
Single bounded task TOOLACT-1 landing together (the pieces are interdependent through the invocationId backbone): rename + un-gate, per-seam recording + correlation id, host-event id stamping, streaming dedup, neutral projection, retention, tests. If Codex must split, order: rename/un-gate -> recording+id per seam -> projection -> retention.

## Risks
- Dedup collapse vs double-count — closed by invocationId in the runner event key + per-frame streaming filter.
- Host/generic double or lost record — closed by id-correlated suppression with fallback.
- Colliding humanized labels merging distinct tools — closed by raw-key grouping.
- Live-turn volume — closed by retention/pruning.
- LangGraph event-shape drift — defensive ok derivation.

## Verify Plan
`python3 factory/scripts/verify.py` green (typecheck + unit + integration + architecture). Projection + per-seam recording + streaming-dedup + retention tests per the task plan pass, across both runtimes.
