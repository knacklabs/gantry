---
issue: SEC-2
title: Inbound attachments: one atomic O_NOFOLLOW writer for Telegram + Slack
status: approved
saved: 2026-08-02T21:04:43+00:00
story: SEC-2
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
  - 0102-runtime-hardening-audit-harvest
---


# SEC-2 — one atomic O_NOFOLLOW writer for inbound Telegram + Slack attachments

## Context

Inbound provider attachments are written by per-channel code without symlink
protection or atomicity. The harvest audit (docs/architecture/
runtime-hardening-audit-2026-07-22.md, decision 0102) called for one atomic
O_NOFOLLOW writer. A full implementation exists unlanded in the myclaw-SEC2
worktree (commit 979264eb8, 13 files, +952/-373): platform/no-follow-fs.ts +
platform/private-file-writer.ts + Telegram/Slack download wiring + tests.
The branch is 362 commits behind main (identity, FILE-1B/2 Discord parity,
CAP-1, LAT-4B all landed since — FILE-1B/2 added Discord attachment paths the
original commit never saw).

## Approach

One bounded task: merge origin/main into the SEC-2 worktree preserving both
sides under the superseded-hunk rule (main wins where it replaced a mechanism;
dropped hunks reported), then reconcile the writer with the attachment surfaces
main gained since — in particular Discord capture (FILE-1B/2) should route
through the same atomic O_NOFOLLOW writer or the gap must be reported
explicitly. No legacy shims.

## Verification

- focused: private-file-writer, private-fs, telegram, slack unit lanes; the
  writer test proves symlink refusal and atomic replace
- full unit + full Postgres integration (parent), typecheck, architecture,
  migrations drift
- formal three-lens findings review (explicit format) before PR — the
  faithfulness-audit-only trap from CAP-1 is documented and avoided
- PR; CI green; nightly agent-e2e dispatch (runtime behavior); merge is human-gated

## Surface Impact

| Surface | Class | Reason |
|---|---|---|
| Runtime behavior | Changed | attachment writes become atomic + symlink-refusing |
| API | Unchanged by design | internal write path only |
| Docs | Unchanged by design | audit doc already records the goal |
| Tests | Changed | writer suite + channel test updates |
