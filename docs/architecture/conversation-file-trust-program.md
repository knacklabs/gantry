# Conversation File Trust Program

Status: active. Governing decision: `docs/decisions/0092-conversation-file-trust-program.md`
(twelve client-grilled locks + the provider parity matrix). Sign-off:
`docs/decisions/0093-client-signoff.md`.
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
| Lazy backfill fetch on first need, via the live pipeline | 0092 §1 |
| Provider deletion honored; agent says "deleted from the channel" | 0092 §2 |
| One 50 MiB cap everywhere | 0092 §3 |
| Versions: latest-wins by name, history mentioned | 0092 §4 |
| Strictly conversation-scoped access | 0092 §5 |
| Ephemeral/self-destruct content never stored | 0092 §6 |
| Per-conversation file search (name/type/date) beyond the window | 0092 §7 |
| Retention: keep until deleted upstream | 0092 §8 |
| Linked files (Drive/Dropbox/SharePoint) ride connectors; honest copy until then | 0092 §9 |

## Phases

### FILE-1A — foundation + Slack complete (now)

- Migration: attachment filename, conversation scope, tombstone, provider
  fetch identity; indexes for the per-conversation search.
- The conversation-scoped attachment resolver; attachments move behind it.
- Slack hydration persists the re-fetch identity it already receives; Slack
  backfill fetch lands through the 0045 writer on first need.
- Honest failure copy ("deleted from the channel" / "I can't get this").
- Real-Postgres integration proof: scoping (a foreign conversation's ref
  refuses), lazy fetch persistence, tombstone behaviour.

### FILE-1B — Discord parity (next)

Discord today captures no bytes even live and drops filenames. 1B brings it
to full Slack/Telegram parity: live capture, filename + fetch identity
persisted, backfill re-fetch by message-id attachment lookup, deletion event
routing, ephemeral-flag handling.

### FILE-1C — Teams parity (deferred, D-0032)

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

## Verification bar

Each phase runs the full Forge lifecycle: premise re-measured against main
(signals on failure), Codex-critiqued plan, per-stage falsified tests, real
Postgres for persistence changes, one three-lens branch autoreview, PRs
through the human merge gate. The falsification discipline applies to every
security-relevant guard: scoping, caps, tombstones, and the resolver being
the only byte path.
