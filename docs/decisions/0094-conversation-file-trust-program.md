---
status: accepted
confirmed_by: "Ravi"
date: 2026-07-30
---

# Conversation File Trust Program — every file shared in chat "just works"

## Context

Users who share a file in a chat the agent lives in trust the agent to have
it — they don't know or care whether the message arrived live or was fetched
back from the provider later. Today that trust holds only partially: Slack
and Telegram capture live files through the hardened descriptor-pinned
writer (decision 0045, 50 MiB streaming cap) with a persisted `storageRef`;
provider-backfilled files everywhere keep only name/type/size with NO way to
open them; Discord never downloads bytes at all (and drops the filename in
persistence); Teams has no download operation in its port and a null default
SDK client. The agent's file-read path is workspace-relative with no
attachment identity or conversation check. Premise failure recorded via
signal `S-0001-e125`.

## Decision

Twelve client-grilled locks (2026-07-30) govern the program:

1. **Lazy fetch**: backfilled attachments keep provider identity and are
   fetched on FIRST NEED through the SAME hardened writer live files use —
   never a parallel storage path (0045 applies unchanged).
2. **Honor provider deletion**: a file learned deleted upstream stops being
   served; the agent says "that file was deleted from the channel".
3. **One size cap** (the live 50 MiB) everywhere.
4. **Versions**: latest-wins by name within the conversation, earlier
   versions mentioned and reachable.
5. **Strictly conversation-scoped access**: a file is readable only from
   the conversation (and its threads) where it was shared — enforced by a
   durable attachment-aware resolver, not workspace layout.
6. **Respect ephemerality**: files on provider-marked ephemeral or
   self-destruct content are never stored.
7. **Searchable stored files**: per-conversation name/type/date lookup over
   the agent's own stored attachments, beyond the context window.
8. **Retention**: keep until deleted upstream; deletion propagation is the
   only reaper.
9. **Linked files (Drive/Dropbox/SharePoint): committed, rides connectors**
   — honest "I need a connector" copy until then.
10. **Provider staging: Slack-complete first** (FILE-1A: durable metadata
    foundation + conversation-scoped resolver + Slack backfill fetch),
    **Discord second** (FILE-1B: live capture + refetch — its live gap is
    part of the same trust debt), **Teams deferred** (D-0034) until a real
    SDK client exists.
11. Foundation requires new durable attachment metadata (filename,
    conversation scope, tombstone, provider fetch identity) — a migration;
    locks 2/4/6/7 are unbuildable without it.
12. User docs ship with the program and stay honest per provider
    (draft corrected: live capture is Slack+Telegram today).

## Consequences

- FILE-1A delivers the foundation every later lock builds on; its resolver
  becomes the ONLY agent path to attachment bytes, closing today's
  unscoped-workspace read as attachments move behind it.
- Lazy fetches re-enter `writeInboundAttachment` under the 50 MiB cap —
  no storage shortcut; provider auth/rate-limit/expiry handling lives at
  the new provider-fetch port.
- Rejected: eager backfill downloading (cost without demand); public-URL
  fetching for linked files (SSRF smell, confusing partial support);
  building the Teams download port over a null client.

## Provider parity matrix — every gap, recorded so none is lost

The end state is a **provider-neutral file capability model**: one port for
"capture a live file", one for "re-fetch a historical file by durable
identity", with capability differences expressed as DATA the adapter reports
(as the hydration-coverage port did in decision 0087) — no provider is the
reference implementation, and a fifth provider inherits the shape.

State on main @ `f1adbc682` per dimension:

| Dimension | Slack | Telegram | Discord | Teams |
| --- | --- | --- | --- | --- |
| Live byte capture (0045 writer, 50 MiB) | YES (`channel-state.ts:558`) | YES (`media-ingestion.ts:150`) | **NO** — metadata only (`discord.ts:550`) | **NO** — metadata only (`teams.ts:419`) |
| storageRef persisted on message | YES | YES | **NO** | **NO** |
| Filename persisted | YES | YES | **NO** — dropped (`canonical-message-repository.postgres.ts:332`) | **NO** |
| Durable re-fetch identity for backfilled files | file id (needs files.info op) | N/A (no history hook) | **NO** — no URL, no filename; message external id only | **NO** — no hostedContents/driveItem locator |
| Provider download op in adapter port | live-only (needs refetch op) | live-only | **NONE** | **NONE** (and default SDK client is null, `teams-sdk-client.ts:3`) |
| Deletion events routed | **NO** (file_deleted/message_deleted unregistered) | **NO** | **NO** (MESSAGE_DELETE unhandled) | **NO** |
| Ephemerality signal captured | **NO** (`is_ephemeral` not read) | **NO** (self-destruct media not read) | **NO** (ephemeral flag not read) | **NO** |
| Rate-limit/auth lifecycle for deferred fetch | bot token in memory, no refresh path | bot token | JSON client retries 3x, no attachment op | Graph auth absent |

Work this implies, staged:

- **FILE-1A (now)**: durable attachment metadata foundation — filename,
  conversation scope, tombstone, provider fetch identity columns +
  migration; the conversation-scoped attachment resolver as the only agent
  path to bytes; Slack backfill re-fetch through the 0045 writer; Slack
  hydration persists the re-fetch identity it already receives.
- **FILE-1B (next)**: Discord reaches full Slack/Telegram parity — live
  capture through the 0045 writer, filename + fetch identity persisted,
  backfill re-fetch via message-id attachment lookup, deletion event
  routing, ephemeral-flag handling.
- **FILE-1C (deferred, D-0034)**: Teams — everything in the matrix, gated
  on a real SDK client; the port grows the SAME neutral operations, never
  Teams-shaped ones.
- **Cross-provider (with 1A foundation, extended per provider as each
  lands)**: deletion-event routing and tombstones; ephemerality capture at
  ingest; per-conversation file search over the new metadata; latest-wins
  version resolution.

Nothing in this matrix may be silently narrowed: a provider that cannot
support a dimension reports that as data (capability kind), and the docs
state it per provider in plain language.
