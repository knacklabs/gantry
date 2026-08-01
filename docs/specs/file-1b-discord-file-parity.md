---
slug: file-1b-discord-file-parity
title: FILE-1B Discord conversation-file parity
status: confirmed
saved: 2026-08-01T03:21:46+00:00
---

# FILE-1B — Discord conversation-file parity

## Capability

A file shared in a Discord conversation the agent participates in satisfies
decision 0094's neutral model: bytes are captured live through the hardened
inbound-attachment writer, the filename and a durable re-fetch identity are
persisted with the message, an old file the agent never captured is lazily
re-fetched on first need, a file deleted upstream is honestly reported as
deleted (tombstoned, never re-fetched), and ephemeral content is never stored.
Unlike the pre-existing Slack live path, Discord bytes are exposed only through
the conversation-scoped attachment resolver.

## Behaviour (acceptance)

1. **Live capture.** A non-ephemeral Discord message with attachments
   persists, per attachment: `file_name`, durable fetch identity
   `{provider:'discord', kind:'attachment_id', id:<attachment_id>,
channelId:<channel_id>, messageId:<message_id>}`, and — on successful
   download — an opaque `provider-attachments/...` storage ref in the
   non-workspace provider store, written by the 0045 writer under the one
   50 MiB per-file cap. The identity's `channelId` is
   the message's actual channel from the live payload (thread messages live
   in their own channel distinct from the conversation), never derived from
   the conversation and never from a transient cache. A failed download
   leaves the metadata row (identity intact, no storage ref) and does not
   affect other attachments on the same message. Route admission occurs before
   any CDN request. Persistence returns `stored` or `dropped`; only `stored`
   transfers ownership, while `dropped` or rejection reclaims all refs created
   for that delivery.
2. **CDN discipline.** Attachment bytes come only from HTTPS
   `cdn.discordapp.com`, with no URL credentials and no port other than the
   default HTTPS port. Redirects are manual, limited to five, and re-validated
   before every hop. Each request omits credentials, Authorization, cookies,
   caller headers, REST headers, and referrer.
   Stored CDN URLs are never trusted for re-fetch (they expire); re-fetch
   always resolves a fresh URL via the message lookup. Live Discord bytes
   are materialized under the resolver-owned provider store and exposed
   ONLY through the scoped attachment-open path — never as a direct
   workspace file reference — so a later deletion tombstone cannot be
   bypassed by an old reference.
3. **Backfill re-fetch.** The conversation-scoped attachment resolver can
   materialize a Discord attachment it has no bytes for: fetch the message
   by (channelId, messageId), locate the attachment by id, download the
   fresh URL through the writer. Discord JSON error code `10008` (Unknown
   Message), or the attachment id absent from a successful message response,
   classifies as `deleted` (tombstone). A bare/other HTTP 404, auth,
   missing-access, rate-limit, malformed-response, abort, and network failures
   stay `unreachable` and are retried on later opens.
4. **Deletion events.** MESSAGE_DELETE (and MESSAGE_DELETE_BULK) for a
   configured route is persisted raw, before any Discord context lookup, as
   one marker row per (app, provider, provider account, channel, external
   message) scoped pair. With a cold
   context cache and no configured route, the same atomic repository call
   first checks canonical Postgres messages for the raw channel/thread key;
   any matching provider account admits the event's complete message-id set,
   while a channel matching neither routes nor stored messages writes nothing.
   Processing resolves the stored channel key against canonical messages, then
   tombstones and consumes only the pair whose message exists. Other bulk or
   shared-credential pairs remain available for their own ingest race. Message
   insertion consumes its exact pair and inserts attachments already
   tombstoned. Retry scans join to existing messages, so unmatched race guards
   do not create repeated per-event work. Provider bytes are reclaimed only
   after commit; the agent thereafter reports the deleted copy without a
   provider call. Discord is the first registrant of the provider-neutral
   repository operation.
5. **Ephemerality.** A message with the EPHEMERAL flag (bit 64) is rejected
   before route admission or normalization. Any attachment marked ephemeral is
   filtered before mapping. Neither case stores bytes or metadata, live or via
   hydration.
6. **Scope.** All access remains strictly conversation-scoped through the
   FILE-1A resolver. Before any provider call, Discord independently requires
   the persisted provider/kind/attachment/channel/message identity to match the
   active provider account and conversation JID/thread id. Persisted identity
   never grants authority; a mismatch is unreachable with zero provider I/O.

## Non-goals

Teams (D-0034); Slack/Telegram deletion-event registration (mechanical
follow-up on the neutral operation); aggregate per-message byte budgets;
eager backfill; public-URL fetching; content-scan metadata.

## Constraints

- The 0117 columns stay sufficient for parity metadata. Deletion durability
  adds one narrow channel-scoped pair marker migration. A coalesced in-process worker
  retries raw events whose first insert fails, with capped backoff. A crash
  during a complete database outage before any insert succeeds remains the
  explicit D-0037 deferral.
- Adapters never mint `provider-attachments/` refs (cleanup invariant).
- The parity matrix in decision 0094 is updated in the same change that
  flips each row, with citations.
