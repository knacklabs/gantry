---
issue: CAP-1
title: Close out the capability-authoring lane
status: approved
saved: 2026-08-02T11:05:19+00:00
story: CAP-1
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
  - 0100-mig-1-client-signoff
  - 0101-oidc-generic-google-first
---


# CAP-1 — Close out the capability-authoring lane

## Context

Rescued WIP (feature/capability-authoring @ 13ae2e698) already carries 8 commits in
/Users/ravikiranvemula/Workdir/myclaw-CAP-1: MCP client adapters moved to the connection
module, NULL binding-scope hydration fix, network-revalidation test pointing at the
exported connectMcpToolProxyClient, architecture-budget splits. Roadmap records this as a
closeout exception (no new goal): verify, ONE autoreview pass, merge; it edits
mcp-tool-proxy.ts so the conflict window must close.

The branch is 358 commits behind main; merging origin/main leaves 22 conflicted files
(bootstrap wiring, settings mirror/import/reload, jobs execution, permission management,
mcp-authorized-servers, and their tests, plus architecture-map).

## Approach

One bounded task: resolve the merge preserving BOTH feature sets (the lane's
capability-authoring/tool-rule changes AND everything main gained — identity threading,
LAT-4B graph-write reduction, FILE-1B/2, PERM work). Weakening an assertion to green a
test is a finding to report, not a fix. Then the closeout gates: typecheck, unit,
relevant integration, check:architecture, one branch autoreview until clean, PR.

## Verification

- npm run typecheck; full unit suite; postgres integration lane
- npm run check:architecture; npm run db:migrations:check
- one branch autoreview pass (chunked) until no accepted findings
- PR to main; CI green; merge closes the mcp-tool-proxy.ts conflict window

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | capability authoring / MCP proxy adapters land |
| API | Unchanged by design | no new public surface in the closeout |
| Docs | Unchanged by design | closeout of an already-decided lane; no new decisions made in this plan |
| Tests | Changed | lane tests + merge fallout |
