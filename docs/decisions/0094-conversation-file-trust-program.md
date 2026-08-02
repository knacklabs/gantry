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

State after FILE-2 per dimension (citations name the current owning surface):

| Dimension                                      | Slack                                                      | Telegram                              | Discord                                                                                                                                                                              | Teams                                                            |
| ---------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Live byte capture (0045 writer, 50 MiB)        | YES (`apps/core/src/channels/slack/channel-state.ts`, live attachment enrichment) | YES (`apps/core/src/channels/telegram/media-ingestion.ts`)   | YES (`apps/core/src/channels/discord-live-attachment-capture.ts`, `deliverLiveDiscordMessage`)                                                                                                              | **NO** — metadata only (`apps/core/src/channels/teams.ts`)                              |
| storageRef persisted on message                | YES                                                        | YES                                   | YES (`apps/core/src/channels/discord-live-attachment-capture.ts`)                                                                                                                                           | **NO**                                                           |
| Filename persisted                             | YES                                                        | YES                                   | YES (`apps/core/src/channels/discord-conversation-context.ts`, `discordMessageAttachments`)                                                                                                                 | **NO**                                                           |
| Durable re-fetch identity for backfilled files | file id (`apps/core/src/channels/slack/historical-attachment-fetcher.ts`)         | N/A (no history hook)                 | attachment + channel + message identity (`apps/core/src/channels/discord-conversation-context.ts`, `discordMessageAttachments`)                                                                             | **NO** — no hostedContents/driveItem locator                     |
| Provider download op in adapter port           | YES (`apps/core/src/channels/slack/historical-attachment-fetcher.ts`)             | live-only                             | YES (`apps/core/src/channels/discord-historical-attachment-fetcher.ts`)                                                                                                                                     | **NONE** (and default SDK client is null, `apps/core/src/channels/teams-sdk-client.ts`) |
| Deletion events routed                         | YES — `message_deleted` routes through `routeSlackDeletion` to one scoped atomic repository call (`apps/core/src/channels/slack/slack-message-deletion.ts`; `apps/core/src/adapters/storage/postgres/repositories/message-attachment-repository.postgres.ts`, `setDeletedAtByMessageExternalIds`) | **NO** — the [Bot API update list](https://core.telegram.org/bots/api#update) has no ordinary bot-chat deletion update; `deleted_business_messages` requires a Business connection Gantry does not model | YES — one scoped atomic repository call per event (`apps/core/src/channels/discord-message-deletion.ts`, `routeDiscordDeletion`; `apps/core/src/adapters/storage/postgres/repositories/message-attachment-repository.postgres.ts`, `setDeletedAtByMessageExternalIds`) | **NO**                                                           |
| Ephemerality signal captured                   | **NO** (`is_ephemeral` not read)                           | **NO** (self-destruct media not read) | YES (`apps/core/src/channels/discord-conversation-context.ts`, `isDiscordEphemeralMessage`)                                                                                                                 | **NO**                                                           |
| Rate-limit/auth lifecycle for deferred fetch   | bot token in memory, no refresh path                       | bot token                             | REST lookup retries 3x with bot auth; fresh CDN URL download is unauthenticated (`apps/core/src/channels/discord-historical-attachment-fetcher.ts`) | Graph auth absent                                                |

Work this implies, staged:

- **FILE-1A (now)**: durable attachment metadata foundation — filename,
  conversation scope, tombstone, provider fetch identity columns +
  migration; the conversation-scoped attachment resolver as the only agent
  path to bytes; Slack backfill re-fetch through the 0045 writer; Slack
  hydration persists the re-fetch identity it already receives.
- **FILE-1B (implemented)**: Discord reaches the scoped program slice — live
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

FILE-1B does not claim that Slack or Telegram workspace reads moved behind the
attachment resolver. Their deletion-event registration and workspace-ref
migration remain pending.
