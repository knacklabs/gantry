---
story: FILE-1B
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
  - 0100-mig-1-client-signoff
---

# FILE-1B — Discord Conversation-File Parity Plan

## Goal (plain language)

When someone shares a file in a Discord channel the agent watches, the agent
should treat it exactly like a Slack file: it saves the bytes right away,
remembers the filename and where it came from, can re-fetch an old file it
never saved when it's first needed, says honestly when a file was deleted
from the channel, and never stores ephemeral content. Today Discord drops the
filename and never saves any bytes at all.

## Premise (re-measured against main 79eb71974)

Verified by read-only exploration on this worktree:
- `discordMessageAttachments` (apps/core/src/channels/discord-conversation-context.ts:381-394) maps id/kind/contentType/sizeBytes/externalId and DROPS `filename`; never sets `file_name`, `provider_fetch`, or `storageRef`. No byte fetch exists in any discord-*.ts.
- `DiscordMessageCreate` (discord-types.ts:14-31) lacks `flags`; `DiscordMessageAttachment` (discord-types.ts:33-38) lacks `url` and `ephemeral`.
- `handleGatewayDispatch` (discord.ts:536-552) handles only READY/MESSAGE_CREATE/INTERACTION_CREATE; MESSAGE_DELETE and MESSAGE_DELETE_BULK arrive (intents include them) and are silently dropped.
- Tests pin the gap: discord.test.ts:988 and :1213 assert attachments have NO filename/url.

## In scope

1. **Types + mapper truth.** Add `flags`, `attachments[].url`, `attachments[].filename` (already present), `attachments[].ephemeral` to the Discord types. `discordMessageAttachments` maps `file_name` and the durable fetch identity `{provider:'discord', kind:'message_attachment', id:<attachment_id>, channelId:<channel_id>, messageId:<message_id>}` (CDN URLs expire ~24h, so identity is the triple, never the URL; extra keys are legal per HistoricalAttachmentFetchIdentity's index signature and the repository CAS compares only provider|kind|id). Ephemeral filtering: skip storage for `message.flags & 64` (live at discord.ts:557 guard, hydration at discord-conversation-context.ts:346-352) and filter `attachment.ephemeral` in the mapper.
2. **Live byte capture.** In `handleMessageCreate`, before `onMessage`: download each attachment's CDN `url` (NO bot-token header — CDN is unauthenticated; sending the token to cdn.discordapp.com would leak it), write through the 0045 inbound-attachment writer (`writeInboundAttachment`) into a workspace `attachments/...` ref (adapters must never mint `provider-attachments/` refs — the cleanup invariant drops them), per-file 50 MiB cap, partial-success semantics identical to Slack's `enrichMessage` (per-file failure noted, remaining files unaffected).
3. **Status-preserving REST helper.** `requestJson` throws `new Error(text)` losing the HTTP status (discord.ts:486,493); add a status-carrying sibling (or discriminated result) so the fetch taxonomy can classify 404→deleted vs auth/rate-limit/network→unreachable.
4. **Backfill re-fetch.** `DiscordChannel.fetchHistoricalAttachment` implementing the `HistoricalAttachmentFetcher` taxonomy: GET `/channels/{channelId}/messages/{messageId}` (transport + 429 retry already exist at discord.ts:475-494), locate `attachments[].id === identity.id`, download the FRESH url through the writer. 404 on the message → `{status:'deleted'}`; missing attachment id in a live message → `{status:'deleted'}` (the attachment was removed by edit); everything else honest `unreachable`. Discovery is duck-typed (channel-wiring-historical-attachments.ts:8-27) — implementing the method is the wiring.
5. **Deletion event routing → tombstones (first provider).** Register MESSAGE_DELETE and MESSAGE_DELETE_BULK in `handleGatewayDispatch`; deletions route to `MessageAttachmentRepository.setDeletedAt` for that message's tracked attachments via the SMALLEST mechanism that types cleanly — a provider-neutral channel-wiring callback (the pattern LAT-5B just proved for distrust), not a new port file unless typing demands one. The durable side (tombstone CAS, reclaim protocol, ATTACHMENT_DELETED_COPY) already exists with zero event callers. The operation stays provider-neutral per 0094; only Discord registers in 1B. Unknown message ids are no-ops.
6. **Capability truth.** Update the 0094 parity matrix rows for Discord that flip (live capture, filename, fetch identity, deletion events, ephemerality) — docs stay honest automatically per the program doc.
7. **Tests.** Mirror the Slack suites: `discord-historical-attachment-fetcher.test.ts` modelled on slack-historical-attachment-fetcher.test.ts (taxonomy incl. cancellation); live-capture unit tests replacing the gap-pinning assertions at discord.test.ts:988/:1058-1059/:1213; real-Postgres proofs extending attachment-resolver.postgres.integration.test.ts with a Discord identity end-to-end (lazy fetch persists, scoping refusal, tombstone via deletion event, 50 MiB refusal); migration-journal guards untouched (no migration needed — 0117 columns are provider-neutral).

## Out of scope

- Teams (D-0034). Slack/Telegram deletion-event registration (follow-up; the port lands neutral, adding providers is mechanical). Aggregate per-message byte budget (10×50 MiB stands; per-file cap is lock 3). Eager backfill. Public-URL fetching. Content-scan metadata.

## Stages

- **FILE-1B-1 — types, mapper, ephemeral skip, live capture, status helper.** Write scope: apps/core/src/channels/ (discord files), apps/core/test/. Falsifiers: filename+provider_fetch asserted on live and hydrated attachments; ephemeral message/attachment stored nowhere (negative control: drop the flag check → test fails); capture failure leaves metadata row without storageRef; CDN download carries no Authorization header (asserted); >50 MiB refused via writer.
- **FILE-1B-2 — historical fetcher + resolver end-to-end.** Write scope: apps/core/src/channels/, apps/core/src/app/bootstrap/ (only if wiring needs it), apps/core/test/. Falsifiers: taxonomy suite (ok/deleted-404/attachment-gone/unreachable/cancellation); real-Postgres lazy fetch + scoping + 50 MiB + tombstone-on-deleted proofs with Discord identities; fresh-URL use (expired stored URL never fetched).
- **FILE-1B-3 — deletion event routing + closeout.** Write scope: apps/core/src/channels/, apps/core/src/app/bootstrap/, apps/core/src/domain/ports/, apps/core/test/, docs/. Falsifiers: MESSAGE_DELETE tombstones exactly that message's attachments (real Postgres); MESSAGE_DELETE_BULK loops; foreign-conversation deletion refused by scope; resolver serves ATTACHMENT_DELETED_COPY after the event with zero provider calls; parity matrix rows flipped with citations. Then: verify.py, ONE 3-lens branch autoreview, artifacts, pr_ready.

## Verification bar

Real Postgres for all persistence proofs (disposable pgvector container, orchestrator-owned lanes). Every security-relevant guard falsified: conversation scoping, cap, tombstone, no-auth-header CDN rule, ephemeral skip, resolver-only byte path. Explicit what-did-not-improve statement at closeout. Codex critique of this plan runs as the first decomposition task before any write stage.

## Surface Impact

- **Runtime behavior**: Changed — Discord live capture, backfill re-fetch, deletion tombstones, ephemeral skip.
- **API (control/SDK/contracts)**: Unchanged by design — the resolver's contract and the neutral identity shape already cover Discord; no new public surface.
- **Data/schema**: Read-only — the 0117 columns are provider-neutral; no migration.
- **CLI/ops**: Unchanged by design — no new commands or settings; capability truth lives in 0094's matrix.
- **UI**: N-A — headless runtime.
- **Docs**: Changed — 0094 parity matrix rows flip with citations; program doc phase status.
- **Tests**: Changed — Discord fetcher taxonomy suite, live-capture units, real-Postgres proofs; gap-pinning assertions rewritten.

## Risks

- Gateway dispatch path now does network I/O per attachment (Slack precedent exists; failure is per-file and non-blocking, and LAT-5B's dispatch-failure distrust does NOT fire for attachment capture failures — the message itself was delivered).
- Thread messages: channel_id for the fetch identity comes from the live payload (message.channel_id), never the conversation JID (threads live in their own channel) and never the 10-minute messageChannelIds cache.
- MESSAGE_DELETE payloads carry only ids (no attachment list) — the tombstone route must look up attachments by message id in OUR store, which is exactly what setDeletedAt's identity predicate supports.
