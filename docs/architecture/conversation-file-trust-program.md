# Conversation File Trust Program

Status: active. Governing decision: `docs/decisions/0094-conversation-file-trust-program.md`
(twelve client-grilled locks + the provider parity matrix). Sign-off:
`docs/decisions/0095-client-signoff.md`.
User-facing documentation ships from the corrected draft (per-provider honest).

## The promise

Someone who shares a file in a chat the agent lives in trusts the agent to
have it. They don't know which path the message arrived by, and they should
never need to. The program's end state, in the user's words:

- "I shared it in chat, so the agent has it" — live or backfilled.
- "I deleted it from the channel, so the agent lost it too."
- "The agent tells me plainly when it can't get a file, and why."
- "A file I shared in #finance never surfaces anywhere else."

## The architecture end state

A **provider-neutral file capability model**, mirroring how hydration
coverage was made neutral (decision 0087):

- One port operation for live capture; one for re-fetching a historical file
  by durable identity. Both funnel every byte through the hardened
  descriptor-pinned writer (decision 0045) under the single 50 MiB cap.
- Capability differences are DATA the adapter reports — a capability kind —
  never Slack-shaped optional fields. A provider that cannot support a
  dimension says so; the docs repeat it in plain language.
- Durable attachment metadata (filename, conversation scope, provider fetch
  identity, tombstone) lives on the attachment record; every later feature
  (deletion, versions, ephemerality, search) reads that one foundation.
- The **conversation-scoped attachment resolver** is the only agent path to
  attachment bytes. Scope is enforced against durable conversation identity,
  not workspace directory layout.

## Feature set (client-locked)

| Feature | Lock |
| --- | --- |
| Lazy backfill fetch on first need, via the live pipeline | 0094 §1 |
| Provider deletion honored; agent says "deleted from the channel" | 0094 §2 |
| One 50 MiB cap everywhere | 0094 §3 |
| Versions: latest-wins by name, history mentioned | 0094 §4 |
| Strictly conversation-scoped access | 0094 §5 |
| Ephemeral/self-destruct content never stored | 0094 §6 |
| Per-conversation file search (name/type/date) beyond the window | 0094 §7 |
| Retention: keep until deleted upstream | 0094 §8 |
| Linked files (Drive/Dropbox/SharePoint) ride connectors; honest copy until then | 0094 §9 |

## Phases

### FILE-1A — foundation + Slack backfill complete

- Migration: attachment filename, conversation scope, tombstone, provider
  fetch identity; indexes for the per-conversation search.
- The conversation-scoped attachment resolver; attachments move behind it.
- Slack hydration persists the re-fetch identity it already receives; Slack
  backfill fetch lands through the 0045 writer on first need.
- Honest failure copy ("deleted from the channel" / "I can't get this").
- Real-Postgres integration proof: scoping (a foreign conversation's ref
  refuses), lazy fetch persistence, tombstone behaviour.

### FILE-1B — Discord scoped parity (implemented)

Discord now captures live bytes through the 0045 writer, persists filename and
fetch identity, lazily re-fetches by message-id attachment lookup, routes
single and bulk deletion events to one scoped atomic tombstone operation, and
skips provider-marked ephemeral content. The current owning surfaces are
`discord-live-attachment-capture.ts`, `discord-conversation-context.ts`,
`discord-historical-attachment-fetcher.ts`, `discord.ts`, and
`message-attachment-repository.postgres.ts`.

### FILE-1C — Teams parity (deferred, D-0034)

Everything in the parity matrix, gated on a real Teams SDK client. The port
grows the same neutral operations — never Teams-shaped ones.

### Cross-provider features (start in 1A, extend as providers land)

Deletion events + tombstones; ephemerality capture at ingest; search;
latest-wins version resolution; the per-provider capability reporting that
keeps the docs honest automatically.

## What is explicitly out of scope

- Eager backfill downloading (rejected: cost without demand).
- Public-URL fetching for pasted links (rejected: SSRF smell, confusing
  partial support; linked files ride connectors).
- Any "never record this sender/file" switch beyond ephemerality — returns
  only as its own loud decision (see 0090's privacy stance).
- Cross-conversation file access, with or without consent UI, until a real
  need arrives with its own decision.

## What FILE-1B did not improve

- The 50 MiB limit remains per file; there is no aggregate per-message cap.
- Slack and Telegram deletion-event registration is still pending.
- Slack and Telegram workspace-reference reads have not moved behind the
  attachment resolver; that workspace-ref migration remains pending.
- Teams remains deferred under D-0034.
- Deletion markers for scopes that never match (foreign or truly unknown
  message ids) are retained indefinitely by design — they are the ingest-race
  guard; a retention sweep is future hygiene, not a correctness gap.
- The durable deletion mechanism is Discord-registered only; the marker
  table and repository operation are provider-neutral and ready for Slack/
  Telegram registration.

## Verification bar

Each phase runs the full Forge lifecycle: premise re-measured against main
(signals on failure), Codex-critiqued plan, per-stage falsified tests, real
Postgres for persistence changes, one three-lens branch autoreview, PRs
through the human merge gate. The falsification discipline applies to every
security-relevant guard: scoping, caps, tombstones, and the resolver being
the only byte path.
