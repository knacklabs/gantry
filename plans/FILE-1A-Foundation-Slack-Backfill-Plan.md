# FILE-1A — Attachment Trust Foundation + Slack Backfill Fetch

Issue: `FILE-1`
Branch: `feat/backfilled-file-extraction`
Base: `origin/main` @ `f1adbc682`
Program: Conversation File Trust (docs/architecture/conversation-file-trust-program.md)
Governing decision: `docs/decisions/0092-conversation-file-trust-program.md`
Sign-off: `docs/decisions/0093-client-signoff.md`
Signal: `S-0001-e125` (contradiction) — raised and resolved before planning

## Problem

A user who shared a file in chat trusts the agent to have it. Today that
holds only for live Slack/Telegram messages. Backfilled attachments keep
name/type/size with no way to open them; the agent's read path is
workspace-relative with no attachment identity, conversation check, or
tombstone; and `message_attachments` has no filename, fetch identity, or
`deleted_at` (`schema/messages.ts:104-123`). Worse, the attachment writer
DELETES and REINSERTS rows on message upsert, preserving only `storageRef`
(`canonical-message-repository.postgres.ts:294-346`,
`canonical-message-attachments.postgres.ts:67-82`) — so any new metadata
must also survive redelivery, or ordinary upserts erase tombstones and
fetch identity.

## Scope / Non-goals

### In scope

1. **Foundation: metadata carried end to end, surviving upserts.** Migration
   `0117` (journal + `postgres-migration-journal.test.ts` update) adds
   nullable `file_name`, `provider_fetch_json`, `deleted_at` to
   `message_attachments`. `NewMessageAttachment` (`domain/types.ts:147-154`),
   the write mapper (`canonical-message-repository.postgres.ts:321-346`),
   the JSON projection (`canonical-message-attachments.postgres.ts:16-42`),
   and the read mapper (`canonical-message-ops-service.ts:114-142`) all
   carry the new fields; the delete/reinsert preservation lookup extends
   beyond `storageRef` so `deleted_at` and `provider_fetch_json` survive
   redelivery upserts. NO search-specific index this phase — the search
   lane defines its query first; queries here use the existing
   `(message_id, id)` index plus the messages conversation index.
2. **Attachment reference protocol.** Every attachment renders a durable
   opaque reference (`gantry_attachment` attribute carrying the attachment
   row id) in addition to today's `gantry_ref` for materialized files —
   unmaterialized backfilled attachments become referenceable at all
   (today the renderer emits `gantry_ref` only from `storage_ref`,
   `messaging/router.ts:195,253-261`).
3. **Conversation-scoped resolver + dedicated tool.** An `application/`
   resolver service (in-memory-fake-testable per the
   `outbound-delivery-service.test.ts` pattern) enforcing: the attachment's
   message belongs to the ACTIVE conversation/threads (derived from the
   runner env `GANTRY_CHAT_JID`/`GANTRY_THREAD_ID`,
   `agent-spawn-helpers.ts:119-161`); tombstone refusal with the locked
   copy; lazy fetch orchestration with resolver-owned single-flight
   (`Map<attachmentId, Promise>` deleted in `finally` — no reusable helper
   exists, do not repurpose `skill-install-lock`). The agent reaches it
   ONLY via a new facade tool (host↔runner bridge through the existing
   facade config seam, `mcp-tools.ts:164-179`) — `FileRead` is untouched.
4. **Backfilled bytes never enter a workspace.** Lazily fetched files
   materialize under a NON-workspace attachment area and are served through
   the tool exclusively — `FileRead`/`FileSearch`/`FileWrite` cannot reach
   them. (Live attachments' existing workspace exposure is pre-existing and
   UNCHANGED; migrating live reads behind the resolver is a later program
   lane, stated in the program doc.)
5. **Slack fetch port + adapter op.** Neutral port "fetch a historical file
   by durable identity"; Slack implements via `files.info` (requires
   `files:read` — ADDED to setup guidance `setup-flow-provider-steps.ts:376-389`
   and `cli/slack.ts:476-494`, reinstall note included) + the bearer
   download helper, upgraded to a DISCRIMINATED result (today it collapses
   all failures to null, `channel-state.ts:594-617`). Error taxonomy:
   ONLY explicit `file_deleted` tombstones; `file_not_found`, `not_visible`,
   auth/scope errors, rate limits, and network failures return
   unreachable/retryable — never a tombstone. Every byte re-enters
   `writeInboundAttachment` (decision 0045) under the single 50 MiB cap.
6. **Hydration + live ingest persist identity.** Slack hydration adds
   filename + file-id fetch identity to the attachments it already builds
   (`conversation-context.ts:655-671`); live Slack (`channel-state.ts:580-648`)
   and Telegram (`media-ingestion.ts:167-188`) pass the ORIGINAL filename
   through the attachment shape (`file_name` is not derivable from the
   sanitized random storage ref).
7. **Honest failure copy**: deleted-from-channel, too-large, and
   can't-reach-it lines.
8. **Real-Postgres proofs** in a dedicated
   `attachment-resolver.postgres.integration.test.ts` on the
   `postgres-integration-runtime` harness (isolated schema + migrations +
   disposable artifact root), fake Slack transport.

### Non-goals

- Discord/Teams (1B / D-0032); deletion EVENT routing; ephemerality capture;
  the search tool and its index; version-resolution UX; migrating LIVE
  attachment reads behind the resolver (program lane, explicitly not
  claimed here).
- Eager backfill; linked files (connectors); cross-conversation access.

## Equivalence contract (precise, superseding wording where older docs differ)

Attachment METADATA changes (new fields, new rendered attribute); rendered
message text, hydrated `messages` content, coverage behaviour, and all
non-attachment persistence remain byte-identical. LAT-5A/GH-352 equivalence
seams are re-asserted at that boundary.

## Acceptance Criteria

- **AC1 (migration + preservation)** — migration `0117` applies on a fresh
  DB and on existing rows; journal + schema-sync test updated; a message
  redelivery upsert PRESERVES `deleted_at` and `provider_fetch_json`
  (falsify: revert the preservation-lookup extension → test fails).
- **AC2 (scoping)** — the tool returns bytes only when the attachment's
  message belongs to the active conversation/threads; a foreign
  conversation's attachment id refuses with not-found copy (falsify: drop
  the conversation predicate → Postgres proof fails). Backfilled bytes are
  not reachable via FileRead/FileSearch (asserted: materialized path lies
  outside every workspace root).
- **AC3 (lazy fetch)** — no `storage_ref` + fetch identity present: first
  resolve fetches via the port, bytes flow through `writeInboundAttachment`
  (falsify: bypass writer → writer-spy assertion fails), the row atomically
  gains `storage_ref`; second resolve makes NO provider call; two CONCURRENT
  resolves make exactly one provider call.
- **AC4 (cap)** — over-50 MiB fetch refuses with too-large copy, persists
  nothing (falsify: raise fixture over cap with cap check disabled → fails).
- **AC5 (tombstone + taxonomy)** — resolving a tombstoned attachment refuses
  with deleted-copy and no provider call; a fetch answered `file_deleted`
  SETS `deleted_at` and refuses thereafter; `file_not_found`/rate-limit/auth
  outcomes do NOT tombstone (each asserted) and return the unreachable copy.
- **AC6 (identity persistence)** — hydrated and live Slack + live Telegram
  attachments persist `file_name` (+ fetch identity for Slack); explicit
  assertions, not `objectContaining` accidents; equivalence contract holds.
- **AC7 (reference protocol)** — every attachment (materialized or not)
  renders its durable reference; `gantry_ref` behaviour for live files
  unchanged.
- **AC8** — release gates green (full lanes, `check:architecture`,
  `verify.py`).

## Surface Impact

| Surface | Classification | Reason |
| --- | --- | --- |
| Runtime behavior | **Changed** | Attachment references render for all attachments; backfilled Slack files fetchable via the new tool; tombstones refuse; live filename persisted. |
| API | **Unchanged by design** | Ports and the facade tool are internal; no control-plane contract changes. |
| Data / schema | **Changed** | Migration 0117: three nullable columns on `message_attachments`; preservation semantics extended. |
| CLI / ops | **Changed** | Slack setup guidance gains `files:read` with a re-authorization note. |
| UI | **N-A** | Chat copy only (honest failure lines). |
| Docs | **Changed** | Program doc committed; setup guidance; PR carries the files:read note. |
| Tests | **Changed** | Migration/journal sync, preservation falsification, resolver unit fakes, dedicated Postgres proofs, taxonomy assertions. |
| Deferred | **Deferred** | Discord (1B), Teams (D-0032), deletion events, ephemerality, search tool + index, version UX, live-read migration behind the resolver — all staged in the program doc. |

## Task Decomposition

**Stage FILE-1A-1 — foundation: schema, mappers, preservation, identity.**
Write scope: `adapters/storage/postgres/schema/` (+`migrations/0117_*`,
journal, `postgres-migration-journal.test.ts`), `domain/types.ts`,
`canonical-message-repository.postgres.ts`,
`canonical-message-attachments.postgres.ts`,
`canonical-message-ops-service.ts`, `channels/slack/conversation-context.ts`,
`channels/slack/channel-state.ts`, `channels/telegram/media-ingestion.ts`,
`messaging/router.ts` (reference protocol), their unit tests, one Postgres
round-trip + preservation test.
AC1, AC6, AC7. Verify: typecheck + touched suites; orchestrator runs the
Postgres round-trip.

**Stage FILE-1A-2 — resolver, tool, Slack fetch port.**
Write scope: `domain/ports/` (fetch port + repository port ops for scoped
lookup and atomic `storage_ref`/`deleted_at` updates), the Postgres
implementation of those ops, `application/` resolver service,
facade tool + host↔runner bridge (`mcp-tools.ts`, facade config),
`channels/slack/` (files.info op + discriminated download result),
channel wiring, setup guidance (`setup-flow-provider-steps.ts`,
`cli/slack.ts`), unit tests with in-memory fakes.
AC2/AC3/AC4/AC5 unit-level with falsifications. Verify: typecheck + scoped
lint + new suites.

**Stage FILE-1A-3 — real-Postgres proofs + closeout.**
Write scope: `apps/core/test/integration/attachment-resolver.postgres.integration.test.ts`
(+ harness touch-ups if needed).
The Postgres proofs: foreign-conversation refusal; lazy fetch persistence +
second-resolve-no-call + concurrent single-flight; cap refusal;
tombstone set-and-refuse; redelivery preservation. Then full lanes + branch
closeout.

## Risks

- **The preservation semantics are the sneaky data-loss path** — AC1's
  falsification exists because the delete/reinsert writer erases anything
  the preservation lookup doesn't carry.
- **Tool-bridge shape**: the facade has no repository access today; the
  bridge must pass through the existing host seam, not grow a parallel IPC.
  Signal if the seam demands more than config threading.
- **Slack taxonomy drift**: only `file_deleted` tombstones. Anything
  ambiguous stays retryable — a wrong tombstone is permanent user-visible
  data loss; a wrong retryable is one wasted call.
- **`files:read` operational note**: existing installs must re-authorize;
  the PR body carries this loudly.
- **Scope honesty**: this phase claims strict scoping for BACKFILLED bytes
  only; the live-attachment workspace exposure is pre-existing, unchanged,
  and scheduled in the program doc — review findings demanding it now
  escalate to the client, not silent widening.

## Verify Plan

1. Falsify AC1 (preservation revert), AC2 (scope predicate), AC3 (writer
   bypass), AC4 (cap off), AC5 (tombstone-on-not_found wrongly) once each;
   record failures in stage evidence.
2. Per stage: smallest suites → local autoreview until clean/adjudicated →
   commit.
3. Closeout: merge main first; full lanes; `verify.py` (envrc vars, no
   GANTRY_TEST_DATABASE_URL, caffeinate); ONE 3-lens branch autoreview;
   artifacts; `pr_ready`; PR through the human merge gate.
4. Disposable container `gantry-file1a-pg`; Codex sandbox cannot reach
   Postgres — orchestrator executes DB lanes.
