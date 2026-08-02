---
story: FILE-2
status: awaiting-approval
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
  - 0097-public-session-conversation-aggregate
  - 0098-streamed-message-projection-timing
  - 0100-mig-1-client-signoff
---

# FILE-2 — Slack Deletion Registration Plan

## Goal (plain language)

When someone deletes a Slack message whose files the agent saved, the agent
treats those files as deleted — honestly reported, bytes removed — exactly as
it already does on Discord. Telegram gets the honest documentation that its
Bot API sends no deletion signal for ordinary chats.

## Premise (verified on this worktree, main b870d21a4)

- Slack `message_deleted` events ARE delivered to the Bolt `message` handler
  and silently discarded by the subtype guard at
  `apps/core/src/channels/slack/channel-message-ingest.ts:108`; the
  `message_changed` line at :109 is dead code behind it.
- The provider-neutral deletion callback is already built once and delivered
  to EVERY channel's opts (`channel-wiring.ts:245-251`, loop :256-275); the
  per-account wrapper injects providerAccountIds
  (`provider-account-channel-connect.ts:171-177`). Slack simply never reads
  the field.
- `SlackMessageLike` (`channel-state.ts:105-123`) lacks `deleted_ts` and
  `previous_message` — the wire payload's deleted-message identifiers.
- Repository channel-key semantics: thread external id, else conversation jid
  (`message-attachment-repository.postgres.ts:460-482`); Slack rows use
  `sl:<channel>` jids and `event.ts` external ids
  (`channel-message-ingest.ts:110,218`).
- Telegram registers no update type that can carry a deletion
  (`telegram/channel-connect.ts:72,752,763`, `media-ingestion.ts:239-281`);
  the Bot API has none for ordinary bot chats.
- Discord's `routeDiscordDeletion` (`discord-message-deletion.ts:15-91`) is
  the template: claim-or-pass return, id extraction, route admission via
  `findConversationRoutesForChat`, unadmitted fallback with
  `requireStoredMessageMatch`, hard error on missing callback.

## In scope

1. **Slack deletion routing.** A `slack-message-deletion.ts` mirroring
   Discord's router: extract `deleted_ts` (extend the Slack event type with
   `deleted_ts`/`previous_message`), channel key =
   `previous_message.thread_ts ?? 'sl:' + channel`, route admission over
   configured routes, unadmitted fallback
   (`fallbackConversationJid: 'sl:' + channel`,
   `requireStoredMessageMatch: true`), `providerId:'slack'`, no
   providerAccountIds (wrapper injects). Invoked from the Bolt `message`
   handler BEFORE the subtype guard so the guard keeps dropping everything
   else; the dead `message_changed` line is removed if the new shape makes it
   unreachable-dead. Missing deleted ts or channel: claim, no durable write.
   Callback failure propagates (never a silent success), consistent with
   Discord's dispatch-failure truth.
2. **Gating.** Registration stays inside the `inbound !== false` Bolt block —
   interaction-only and live-turns-off connections never observe deletions.
   Asserted, not assumed.
3. **Capability truth.** 0094's matrix: Slack deletion-events row flips YES
   with citations; Telegram row documents the no-signal reality
   (ordinary chats; deleted_business_messages needs a Business connection we
   do not model). Program doc updated.
4. **Tests.** Mirror the FILE-1B suites: unit routing tests (single event,
   thread scoping, unadmitted fallback payload, interaction-only silence,
   missing-ts no-op, callback-failure propagation) modelled on
   discord.test.ts:2816-3019; the channel-wiring provider-neutral test
   already exists with providerId 'slack'
   (channel-wiring.test.ts:247-288); real-Postgres proof extending
   attachment-resolver.postgres.integration.test.ts: a Slack deletion event
   tombstones exactly the tracked attachments (delete-before-insert race
   included) and the resolver serves ATTACHMENT_DELETED_COPY with zero
   provider calls.

## Out of scope

Telegram Business accounts; Slack `message_changed` reconciliation (D-0039
class); eager `file_deleted` routing (read-time taxonomy already tombstones —
a new identity-based repository op would buy latency only); Teams (D-0034).

## Surface Impact

- **Runtime behavior**: Changed — Slack deletions tombstone attachments.
- **API (control/SDK/contracts)**: Unchanged by design — the neutral callback
  and repository operations are untouched.
- **Data/schema**: Read-only — no migration, no new operations.
- **CLI/ops**: Unchanged by design — no new scopes needed (message events
  already subscribed).
- **UI**: N-A — headless runtime.
- **Docs**: Changed — 0094 matrix + program doc.
- **Tests**: Changed — routing units + real-Postgres proof.

## Stages

- **FILE-2-1 — routing + gating + docs + proofs (single stage).** Write
  scope: `apps/core/src/channels/`, `apps/core/test/`, `docs/`. Falsifiers:
  deleted_ts (not event ts) reaches the callback; thread channel key when
  `previous_message.thread_ts` present, `sl:` jid otherwise; unadmitted
  fallback payload asserted field-for-field; interaction-only connection
  routes nothing (structural); missing deleted ts claims without durable
  writes; callback rejection propagates; real-Postgres: tombstone exactness +
  delete-before-insert marker retention + zero-provider-call deleted copy.
  Then closeout: verify.py, ONE 3-lens branch autoreview, artifacts,
  pr_ready.

## Verification bar

Real Postgres for the persistence proofs (orchestrator-owned lanes). The
routing guards falsified with reversible negative controls. Explicit
what-did-not-improve statement: message_changed reconciliation and eager
file_deleted remain out; Telegram remains signal-less.

## Risks

- The Bolt handler receives every subtype; routing BEFORE the guard must
  claim ONLY `message_deleted` and pass everything else through untouched
  (regression risk on ordinary ingest — pinned by existing ingest tests).
- Slack sends `deleted_ts` at top level and the full deleted message in
  `previous_message`; thread scoping must come from `previous_message.thread_ts`
  (the event itself has no thread_ts for the deleted message).
