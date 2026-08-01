---
slug: file-1b-discord-file-parity
title: FILE-1B Discord conversation-file parity
status: confirmed
saved: 2026-08-01T03:21:46+00:00
---

# FILE-1B — Discord conversation-file parity

## Capability

A file shared in a Discord conversation the agent participates in behaves
exactly like a Slack file under decision 0094's neutral model: bytes are
captured live through the hardened inbound-attachment writer, the filename
and a durable re-fetch identity are persisted with the message, an old file
the agent never captured is lazily re-fetched on first need, a file deleted
upstream is honestly reported as deleted (tombstoned, never re-fetched), and
ephemeral content is never stored.

## Behaviour (acceptance)

1. **Live capture.** A non-ephemeral Discord message with attachments
   persists, per attachment: `file_name`, durable fetch identity
   `{provider:'discord', kind:'message_attachment', id:<attachment_id>,
   channelId:<channel_id>, messageId:<message_id>}`, and — on successful
   download — a workspace `attachments/...` storage ref written by the 0045
   writer under the one 50 MiB per-file cap. The identity's `channelId` is
   the message's actual channel from the live payload (thread messages live
   in their own channel distinct from the conversation), never derived from
   the conversation and never from a transient cache. A failed download
   leaves the metadata row (identity intact, no storage ref) and does not
   affect other attachments on the same message.
2. **CDN discipline.** Attachment bytes come from the message's CDN URL
   with NO Authorization header. Stored CDN URLs are never trusted for
   re-fetch (they expire); re-fetch always resolves a fresh URL via the
   message lookup.
3. **Backfill re-fetch.** The conversation-scoped attachment resolver can
   materialize a Discord attachment it has no bytes for: fetch the message
   by (channelId, messageId), locate the attachment by id, download the
   fresh URL through the writer. HTTP 404 on the message, or the attachment
   id absent from a live message, classifies as `deleted` (tombstone);
   auth / rate-limit / network failures stay `unreachable` and are retried
   on later opens.
4. **Deletion events.** MESSAGE_DELETE (and MESSAGE_DELETE_BULK) for a
   message whose attachments we track tombstones those attachments; the
   agent thereafter reports the deleted copy without any provider call.
   Deletions for unknown messages are no-ops. The routing operation is
   provider-neutral; Discord is its first registrant.
5. **Ephemerality.** A message with the EPHEMERAL flag (bit 64), and any
   attachment marked ephemeral, is never stored — no bytes, no metadata —
   live or via hydration.
6. **Scope.** All access remains strictly conversation-scoped through the
   FILE-1A resolver; a foreign conversation's reference refuses exactly as
   for Slack.

## Non-goals

Teams (D-0034); Slack/Telegram deletion-event registration (mechanical
follow-up on the neutral operation); aggregate per-message byte budgets;
eager backfill; public-URL fetching; content-scan metadata.

## Constraints

- No schema migration: the 0117 columns are provider-neutral and suffice.
- Adapters never mint `provider-attachments/` refs (cleanup invariant).
- The parity matrix in decision 0094 is updated in the same change that
  flips each row, with citations.
