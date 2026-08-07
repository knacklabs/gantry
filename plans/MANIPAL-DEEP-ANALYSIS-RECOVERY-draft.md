---
decisions_reviewed: [0000-credential-broker-boundary, 0001-agent-runtime-platform, 0002-symphony-forge-adoption, 0003-early-stage-no-backcompat, 0004-gantry-naming-and-public-repo, 0005-runtime-stack, 0006-config-secret-source-boundary, 0007-settings-runtime-truth, 0008-storage-backend-cutover, 0009-canonical-domain-schema-cutover, 0010-claude-runtime-materialization, 0011-provider-session-artifact-store, 0012-browser-capability-boundary, 0013-runtime-event-exchange, 0014-external-ingress-vs-outbound-webhooks, 0015-model-catalog-and-cache-accounting, 0016-event-bus-outbox-boundary, 0017-jsonb-runtime-payload-boundary, 0018-provider-neutral-agent-execution-adapter, 0019-simple-permission-and-job-tool-lifecycle, 0020-mcp-source-vs-action-capability, 0021-capability-artifacts, 0022-delivery-vehicle, 0023-deployment-modes, 0024-locked-preset, 0025-settings-authority, 0027-process-roles-and-multi-live, 0028-agent-harness-selection, 0029-agent-communication-reaction-binding, 0030-agent-communication-reasoning-safety, 0031-send-message-files-authority, 0032-signed-artifact-links-deferred, 0033-teams-reactions-deferred, 0034-client-signoff, 0035-epics-approved, 0040-permission-execution-two-axis-model, 0041-client-signoff, 0042-decision-view-16k-prefix-stripped, 0043-classifier-risk-only-engine-authz, 0044-ci-runner-isolation, 0045-inbound-attachment-descriptor-writer, 0046-llm-process-local-admission, 0050-agent-removal-projection-cleanup, 0051-client-signoff, 0052-birthright-self-surface, 0053-permission-no-timeout-interactive, 0054-decision-provenance-and-risk-label, 0055-client-signoff, 0056-durable-cancellation-invariant, 0057-arch1-client-signoff, 0058-readonly-scheduler-birthright, 0062-perm6-client-signoff, 0063-perm7-client-signoff, 0064-client-signoff, 0065-perm8-client-signoff, 0066-race-1-skill-artifact-app-isolation, 0067-client-signoff, 0068-race-2-cluster-fenced-settings-projection, 0069-client-signoff, 0070-client-signoff, 0071-race-4-browser-profile-lock-aba, 0072-client-signoff, 0073-race-6-profile-mirror-version-guard, 0074-race-8-mandatory-atomic-async-admission, 0075-race-9-serialize-file-backed-settings-write, 0076-client-signoff, 0077-race-5-lease-loss-lifecycle, 0078-lat-3a-single-memory-hydration-per-turn, 0079-client-signoff, 0080-lat-3b-retain-authoritative-second-fetch, 0081-client-signoff, 0082-fence-1-durable-lease-generation, 0083-conv-001-client-signoff, 0084-client-signoff, 0085-lat-4a-fused-inbound-envelope-transaction, 0086-client-signoff, 0087-lat-5-durable-provider-history-coverage, 0088-client-signoff, 0089-thread-turns-read-channel-context, 0090-sender-allowlist-trigger-only, 0091-client-signoff, 0092-client-signoff, 0093-client-signoff-is-a-pinned-project-gate, 0094-conversation-file-trust-program, 0095-client-signoff, 0096-thread-recency-message-timestamp, 0097-public-session-conversation-aggregate, 0098-streamed-message-projection-timing, 0099-rate-limits-singleton-authority, 0100-mig-1-client-signoff, 0101-oidc-generic-google-first, 0102-runtime-hardening-audit-harvest, 0103-live-admission-terminal-retention, 0104-co-1-recovery-intent-reframe]
---

# Manipal deep-analysis runtime recovery boundary

## Outcome

Add the smallest provider-neutral failure contract needed for an application to
recover a scheduled completion-gate continuation from its own durable state,
and publish the already-existing model-credential control routes through the
SDK client shape Agent.Tender consumes.

## Decisions

- Gantry reports continuation failure; it does not restart Manipal stages.
- One new stable failure code extends the existing failure metadata JSON.
- Completion still requires gate acceptance and AJV validation in the same run.
- Model credentials reuse existing authenticated routes and redacted contracts.
- Release `@gantry/sdk` as `0.6.1`; do not change contracts package version.

## Tasks

1. Add `completion_continuation_failed` to the existing failure-code union and
   public projection.
2. Track when a caller completion continuation is active and wrap only errors
   raised during that continuation with the stable code while preserving the
   original redacted message.
3. Add boundary and execution tests proving successful continuation, coded
   failure, unrelated-failure isolation, and no false completion.
4. Add `models.credentials` list/put/patch/disable methods to the SDK, test the
   exact routes, and release SDK `0.6.1`.

## Verify Plan

- Run focused Claude runner boundary and scheduled execution tests.
- Run async-task public-projection tests.
- Run SDK tests, generated OpenAPI drift check, build, and typecheck.
- Run deterministic Forge verification after the implementation tests pass.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Continuation-time provider failures receive one stable code. |
| API | Changed | Existing failure JSON permits the additive code; existing credential routes are exposed by the SDK. |
| Data/schema | Unchanged by design | Failure payloads already use JSON and credentials already exist. |
| CLI/ops | Unchanged by design | No command, setting, secret source, or deployment topology changes. |
| UI | N-A | No Gantry UI behavior is involved. |
| Docs | Changed | The confirmed capability spec records the boundary. |
| Tests | Changed | Runner, failure projection, and SDK routes gain focused regression coverage. |

## Non-goals

- Application-specific checkpoint state, task retry policy, prompt changes,
  Langfuse deployment configuration, fallback models, and report validation.
