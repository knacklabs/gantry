---
issue: CLIRUN-1
title: Structured invocation for local-CLI capabilities
status: approved
saved: 2026-08-11T03:49:35+00:00
story: CLIRUN-1
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
---

# CLIRUN-1 — Structured invocation for local-CLI capabilities

## Problem

A `local_cli` capability pins its executable but is invoked by the agent
authoring a shell string projected to a `RunCommand` rule
(`semantic-capabilities.ts:202-206`). Agent-authored shell lets benign
post-processing (`| head`) miss the per-leaf scoped match, drop to the
non-deterministic classifier, and — on autonomous runs — fail terminally with no
button (0115). This took down the KnackLabs job. Symptom patches (safe-pipe
allowlists) only move the boundary. Decision 0120 (Codex-critiqued design in
`docs/architecture/cli-capability-structured-invocation-design.md`) is the
durable fix: invoke these capabilities structurally so no shell exists.

## Scope / Non-goals

In scope: a structured host tool that runs a granted `local_cli` capability from
an argument LIST through the existing sandboxed, output-bounded executor, with
structured argv validation against the reviewed pattern and invocation-time
executable verification; wiring the pilot capability (gog) + agent guidance;
retiring the `RunCommand` projection for `local_cli` at cutover.

Non-goals: MCP capabilities, skill actions, general Bash/RunCommand for
non-capability commands; a new sandbox model; composite/piped capabilities (a
genuine pipe becomes a separately reviewed capability later).

## Acceptance Criteria

1. A granted `local_cli` capability runs via the structured tool on an autonomous
   run with no shell string composed, no classifier consult, and bounded output;
   an unreviewed subcommand/flag, excess argument, NUL, or oversized input is
   rejected.
2. Execution reuses the existing sandbox + output-boundary + timeout/cancellation
   (not a bare `execFile`), and the executable identity is verified at
   invocation.
3. After cutover the `RunCommand` projection no longer authorizes these
   capabilities; existing scheduled jobs invoke via the structured path (no
   dual-run).

## Technical Approach

The dispatcher builds the command from validated STRUCTURED args (capability +
argv list) and runs it through the SAME bounded/sandboxed runtime executor the
Bash/RunCommand path uses — so truncation, streaming, timeout, cancellation, and
audit redaction come for free (Codex critique correction #5). Argv is validated
against the capability's reviewed pattern with the existing matcher
(`bashScopeMatchesLeaf` on structured argv, no shell), rejecting unreviewed
subcommands/flags/excess/NUL/oversize (correction #1). The executable's identity
is verified at invocation against `executableHash` (correction #4/#7). At cutover
the `local_cli` -> `RunCommand(template)` projection is removed and the pilot
capability + guidance point at the structured tool (corrections #5/#6).

## Decisions

Decision 0120 (local-CLI structured invocation) governs this story; no other new
decision. A genuine-pipe/composite capability is explicitly deferred.

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | new structured invocation tool; RunCommand projection retired for local_cli at cutover |
| Data/schema | Unchanged | reuses capability definition fields |
| API/CLI | Changed | new agent-facing structured tool |
| UI | Unchanged | none |
| Docs | Changed | decision 0120, design doc, agent guidance |
| Tests | Changed | dispatcher validation + execution + cutover |

## Task Decomposition

1. **CLIRUN-1-1** — the structured invocation tool + host dispatch: resolve the
   granted capability, validate argv structurally against the reviewed pattern
   (reject unreviewed subcommand/flag/excess/NUL/oversize), verify executable
   identity at invocation, execute through the existing sandboxed output-bounded
   executor, return bounded output. Deterministic auth; no classifier.
2. **CLIRUN-1-2** — wire the pilot `local_cli` capability (gog) to the structured
   tool and add agent guidance to prefer it over shelling out.
3. **CLIRUN-1-3** — cutover: retire the `local_cli` -> RunCommand projection so it
   no longer authorizes these capabilities; ensure existing scheduled jobs invoke
   via the structured path.

## Risks

- Argv validation must be as strict as the shell matcher was — a flag that
  changes behaviour (`--config`, `--output`) must be rejected unless reviewed.
- Reusing the existing executor must not fork a second execution path; if the
  executor is entangled with shell parsing, that seam must be found first
  (CLIRUN-1-1 pins it before code).
- Cutover is a behaviour change; retiring the projection must not strand a
  capability that has no structured path yet — pilot must be wired first (1-2
  before 1-3).

## Verify Plan

```bash
npm run typecheck && npm run check:architecture
npx vitest run -c vitest.unit.config.ts apps/core/test/unit/runner apps/core/test/unit/shared apps/core/test/unit/runtime
python3 factory/scripts/verify.py
```
Live smoke after merge: resume the KnackLabs job and confirm the sheets
capability runs via the structured tool with no pause and bounded output.

## Implementation Assumptions

<!-- Made during implementation, NOT part of the approved plan. Dev: review these before merge; promote any that matter to docs/decisions/. -->
- 2026-08-11: CLIRUN-1-1 caps capability_run argv at 64 arguments, 4096 UTF-8 bytes per argument, and 16384 UTF-8 bytes total; each reviewed wildcard matches exactly one non-flag argument.
