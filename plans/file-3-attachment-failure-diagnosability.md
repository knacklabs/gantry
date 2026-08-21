---
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
---

# FILE-3 — Attachment failures say which cause

## Problem

A deployment reported `attachment_open` failing for every Slack file, every
file type, with one sentence — "I can't get that file from the channel right
now." — and no log line anywhere. Nothing in that output distinguishes a missing
`files:read` scope from a channel the bot isn't in, a 110s resolver deadline, a
120s runner no-response timeout, or `incapable` account routing. The operator's
one safety net, `gantry provider doctor`, can report green while the token lacks
`files:read`, because the feature-scope warning is dropped when two `ok`
validations fold into an unconditional pass.

Two beliefs were disproved while diagnosing, and the plan must not reintroduce
them: Slack downloads DO send `Authorization: Bearer` (so the reporter's third
hypothesis is out), and a Slack API failure does NOT surface a reason to the
user — failures normalise into `unreachable`, and
`ipc-attachment-open-handler.ts:83-96` wraps a thrown `openAttachment` in a
*successful* IPC envelope carrying the generic copy. Spec:
`docs/specs/file-3-attachment-failure-diagnosability.md`.

## Scope / Non-goals

In scope: one classification point for attachment-fetch failures, cause-specific
user copy, one warn log per classified failure with safe fields, logs for the
three currently silent paths, and a provider doctor whose feature-scope warning
survives aggregation.

Non-goals: the IPC-boundary refactor that stops collapsing thrown failures into
successful envelopes (locked out of this story, deferral with trigger); changing
Slack OAuth scope requirements or the install flow; provider-specific causes
beyond what the shared classification covers; making the doctor fail on a
missing feature scope (locked: warn, don't fail).

## Acceptance Criteria

1. One classification function maps a fetch failure to exactly one cause:
   `permission_scope`, `not_a_member`, `not_visible`, `deleted`, `too_large`,
   `rate_limited`, `timeout`, `transport`, `unknown`. It is the single place
   that decides a cause; adapters supply evidence, not copy.
2. Each cause has one plain-English sentence that says what happened and, where
   an action exists, what would fix it. No stack traces, tokens, URLs, provider
   payloads or internal identifiers appear in user-visible text. `unknown` keeps
   today's sentence and is the only path to it.
3. Slack evidence maps correctly: `missing_scope` and 403 → `permission_scope`;
   `not_in_channel` / `channel_not_found` / `file_not_visible` →
   `not_a_member` / `not_visible`; `file_deleted` → `deleted`; 429 →
   `rate_limited`; network/abort → `transport`. A falsifier per mapping.
4. Every classified failure logs exactly once at warn with: cause, provider,
   providerAccountId, conversationJid, attachmentId, provider status code when
   present, elapsed ms. No token, signed URL, file bytes or file content. A
   falsifier asserts the redaction, not just the presence of fields.
5. The three silent paths log with the same shape: the resolver deadline
   (~110s), the runner no-response timeout (~120s), and `incapable` routing.
6. A Slack token missing `files:read` produces a named doctor warning that
   survives aggregation — it names the scope and the reinstall step and points
   at `docs/operations/slack-app-install.md` — while the check still passes.
7. End-to-end for the reported scenario: `files:read` missing, any file type →
   the permission sentence to the user and exactly one `permission_scope` warn
   log. This is the story's headline falsifier.

## Technical Approach

1. **Classification module** (`apps/core/src/application/attachments/`): a pure
   function from provider evidence (provider id, error code/string, HTTP status,
   abort/timeout marker) to a cause. Pure and table-driven so each mapping is a
   one-line test. Adapters gain a small evidence shape; they do not choose copy.
2. **Copy** lives beside the existing `ATTACHMENT_*_COPY` constants in
   `attachment-resolver.ts`, one per cause, reusing the existing not-found /
   deleted / too-large strings where they already say the right thing.
3. **Carry the cause without changing the IPC contract** (the refactor is out of
   scope): the resolver's failure results already carry `status` + `content`;
   extend the internal result with an optional `cause` and let the handler pick
   copy and emit the log from it. Where a cause cannot be carried without
   touching the envelope, classify and log at the point of failure instead and
   keep the existing envelope shape.
4. **Logging** at the classification boundary so there is exactly one line per
   failure: log where the cause is decided, not at each rethrow. Redaction is a
   property of the log builder, not of each call site.
5. **Doctor**: stop the aggregate pass from discarding feature-scope warnings
   (`cli/slack.ts`, `cli/model-credential-verify.ts`); surface them as named
   warnings on a passing check.

## Decisions

No new decisions. The three product choices are recorded in the confirmed spec
(locked with Ravi 2026-08-06) and none of them changes an existing decision
record; decision 0094 (conversation file trust program) already governs this
area.

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Failure classification and per-cause logging |
| API | Unchanged by design | No HTTP/MCP surface change; the IPC envelope shape is deliberately untouched (refactor deferred) |
| Data/schema | Unchanged by design | No stored attachment fields change |
| CLI/ops | Changed | Provider doctor surfaces feature-scope warnings |
| UI | N-A | No web UI in scope |
| Docs | Changed | Spec, install-doc pointer from the doctor warning |
| Tests | Changed | Mapping table, redaction, silent-path logs, doctor warning |

## Task Decomposition

- FILE-3-CRITIQUE: adversarial verification of the premises against the code
  before implementation (do the cited behaviors reproduce; is the "classify
  without touching the envelope" approach actually possible; what is missed).
- FILE-3-1: classification module + Slack evidence mapping + per-cause copy
  (criteria 1-3).
- FILE-3-2: one warn log per classified failure with redaction, plus the three
  silent paths (criteria 4-5).
- FILE-3-3: doctor feature-scope warning survives aggregation (criterion 6).
- FILE-3-FUNCTIONAL: end-to-end walkthrough of the reported scenario and the
  other causes; behavior-to-test map entry (criterion 7).

## Risks

- **Copy that leaks internals.** Mitigation: redaction asserted by test, and
  copy reviewed against the plain-language rule; no provider payloads.
- **Classifying too eagerly** — mapping an ambiguous provider error to a
  confident cause misleads worse than the generic line. Mitigation: `unknown`
  is a first-class outcome and the default; a mapping needs evidence.
- **Double logging** if a failure is classified at more than one layer.
  Mitigation: one classification boundary, asserted by a "logs exactly once"
  falsifier.
- **The deferred refactor limits reach**: some paths may not be able to carry a
  cause without touching the envelope. Mitigation: those classify-and-log at the
  failure point; if any user-visible path genuinely cannot be fixed without the
  refactor, record it as a deferral rather than widening scope silently.

## Verify Plan

- Per stage: focused vitest suites for the touched modules plus local autoreview
  until clean, then commit.
- Story close: `python3 factory/scripts/verify.py` run solo, ONE 3-lens branch
  autoreview, functional check via a delegated stage, then pr_ready.
- Headline falsifier: simulate a Slack `missing_scope` response end to end and
  assert both the user sentence and the single `permission_scope` log line.
