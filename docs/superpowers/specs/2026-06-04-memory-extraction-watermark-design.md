# Memory extraction read-watermark (process-once) + dreaming enablement

**Date:** 2026-06-04
**Status:** Design approved; ready for implementation plan
**Scope owner:** Boondi / Gantry memory pipeline

## 1. Problem

Gantry's memory **extractor** re-reads and re-extracts the same conversation turns
on every run, producing large piles of near-duplicate `memory_evidence` (observed:
**154 evidence rows for one number, ~147 of them the same nut-allergy fact** under
~15 different keys). Root cause is a mismatch in the existing pipeline:

- The idle sweep **gates** extraction on a per-session watermark — it only re-runs a
session when `last_inbound_at > last_digest_at`
(`apps/core/src/runtime/idle-session-sweep.ts:69-100`, `IDLE_CANDIDATES_SQL`).
- But the extractor **reads** `listRecentMessages({ conversationId, threadId, limit: 80 })` (`apps/core/src/memory/boundary-extraction-core.ts:115-119`) — the
recent 80 messages of the whole conversation, **ignoring that watermark**. So it
re-reads old turns every run and re-emits their facts.

`recordEvidence` is append-only with no dedupe
(`apps/core/src/memory/app-memory-service.ts:131-152`), and the intended downstream
dedupe (the extractor skipping anything already in `retrieved_items`, plus dreaming's
key-based consolidation) only works once `memory_items` is populated — which requires
**dreaming**, which is **disabled by default** (`memory.dreaming.enabled: false`).
Net: with dreaming off, nothing prevents or cleans the duplication; and even with it
on, dreaming is a nightly cron, so dupes accumulate within each window. The
architecturally-correct fix is to make extraction **read by the watermark too**, so
each message is processed once.

## 2. Goal & scope

Make memory extraction **process each message at most once** (a precise read
watermark), so duplicate evidence is not generated in the first place — and turn on
dreaming so consolidated, durable memory actually reaches the agent and the dashboard.

**In scope**

1. **Read-watermark (Gantry core):** extraction reads only messages newer than a
  precise per-conversation watermark, plus a small read-only context window.
2. **Canonical keys (Boondi prompt):** tighten `memory_extractor.md` so facts get
  stable/canonical keys (so genuinely-repeated mentions collapse cleanly in dreaming).
3. **Enable dreaming (config):** `memory.dreaming.enabled: true`, cron `0 1 * * *`
  (daily 01:00).

**Out of scope (explicit)**

- Embeddings / semantic dedupe (`memory.embeddings` stays disabled).
- One-time backlog cleanup of existing dup evidence.
- Ongoing retention / GC of digests or evidence.
- Rationale: the operator will **reset Postgres to an empty state and re-test**, so
there is no backlog to clean and no migration/backfill of existing rows to handle.

## 3. Key design decisions (locked)

- **Watermark storage:** a **dedicated `memory_extraction_cursor` table** — one
upserted row per (app, agent, conversation, thread) holding `covered_through_at` +
`covered_through_message_id`. Keeps responsibilities separate: `memory_evidence` =
findings, `agent_session_digests` = short-term-memory summary, the cursor =
extraction progress. (Chosen over piggybacking the cursor on the digest, which would
conflate short-term memory with pipeline bookkeeping. The cursor advances on every
successful run — fact or no fact — so it depends on neither evidence nor the digest's
contents.)
- **Read model:** extract from **new-since-watermark** turns, and additionally fetch
the **~5 turns at/before the watermark as read-only context** (clearly marked
"context — do not extract"), for coherence and cross-boundary corrections. Zero
duplicate evidence (context turns are never extraction targets).
- **Watermark must be precise** (track the exact last-covered message, not the
digest's write-time) so a message arriving mid-extraction is never skipped.

## 4. Architecture & data flow (new)

Per session the idle sweep deems eligible:

1. **Watermark lookup:** read the `memory_extraction_cursor` row for (app, agent,
  conversation, thread) → `wm = covered_through_at` (+ message id). No row ⇒
   first-ever extraction for this conversation.
2. **Read:**
  - `NEW` = messages where `created_at > wm` (tie-broken by id), capped at ~80,
   ordered oldest→newest. `null` watermark ⇒ bounded recent read (bootstrap), same
   as today.
  - `CONTEXT` = up to ~5 messages at/before `wm`, fetched **read-only**.
3. **Early-out:** if `NEW` is empty ⇒ no-op (no digest, no LLM call).
4. **Extract:** prompt = CONTEXT turns (marked non-extractable) + NEW turns
  (extraction targets) + `retrieved_items` (prior `memory_items`, for skip-known /
   supersedes). Facts come from NEW turns only.
5. **Persist:** write evidence for facts (unchanged) and the digest (unchanged
  summary), **then UPSERT the cursor** to `covered_through_at = max(created_at of  NEW)`, `covered_through_message_id = that message's id` → this advances the
   watermark. The cursor upsert is last, so a failure before it leaves the watermark
   unmoved.

Dreaming (cron, now enabled @01:00) consumes evidence → `memory_items` (unchanged).
Hydration still injects recent digests + `memory_items` (entirely unchanged).

## 5. Components / files

**Gantry core**

- `apps/core/src/adapters/storage/postgres/schema/...` (+ a migration): create the new
`memory_extraction_cursor` table (see §6). `agent_session_digests` and
`memory_evidence` are **unchanged**.
- New `**MemoryExtractionCursorRepository`** (port in `domain/ports/repositories.ts` +
Postgres impl): `getCursor({ appId, agentId, conversationId, threadId })` →
`{ coveredThroughAt, coveredThroughMessageId } | null`; `upsertCursor({ …scope…, coveredThroughAt, coveredThroughMessageId })`. Wire into the repository registry.
- `apps/core/src/adapters/storage/postgres/repositories/domain-repositories.postgres.ts`
(`PostgresMessageRepository`): add `getMessagesSince` (`created_at > since`,
tie-broken by id, oldest→newest, limited) and `getMessagesBefore` (the last N
messages at/before the cursor — the read-only context window). Both bounded; no
writes. Add to the `MessageRepository` port too.
- `apps/core/src/memory/boundary-extraction-core.ts`: the core change — watermark
lookup (from the cursor); new+context read (replacing `listRecentMessages(80)`); mark
context turns read-only in the prompt payload; **UPSERT the cursor** after a
successful digest write; early-return when no new messages. Extend
`BoundaryMemoryRepositories` with the cursor repo + the two new message reads, and
wire them through `app-memory-session-boundary-collector.ts` +
`runtime-app.ts collectRuntimeSessionMemory`.
- `apps/core/src/runtime/idle-session-sweep.ts`: `IDLE_CANDIDATES_SQL` eligibility
switches from the per-session `last_digest_at` LATERAL to a `memory_extraction_cursor`
join on (`agent_id`, `conversation_id`, `thread_id IS NOT DISTINCT FROM`), requiring
`cursor.covered_through_at IS NULL OR last_inbound_at > cursor.covered_through_at`.
**Required, not just efficiency:** a per-session watermark leaves a conversation's
*other* sessions perpetually eligible once one session covered the messages (the read
early-outs and writes nothing to advance a per-session marker); the per-conversation
cursor advances once and covers them all. Null cursor ⇒ still eligible (first run).
- `agent_session_digests` / `AgentSessionDigest` domain type / digest repo:
**unchanged**. Hydration (`hydrate-agent-context-service.ts`, `app-memory-recall.ts`,
`loadRecentDigests`): **untouched**.

**Boondi (agent-owned, not core)**

- `agents/boondi_support/memory_extractor/memory_extractor.md`: canonical keys —
reuse the exact `key` from `retrieved_items` on a match; use a stable canonical slug
for common facts (e.g. one `constraint:nut-allergy` rather than many variants);
treat context-only turns as non-extractable; stricter skip-known.

**Config (runtime home)**

- `~/gantry/settings.yaml`: `memory.dreaming.enabled: true`,
`memory.dreaming.cron: '0 1 * * *'`.

## 6. Data model

New table `memory_extraction_cursor` — extraction progress, one row per scope:


| Column                       | Type                               | Notes                                                  |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `id`                         | text PK                            | deterministic: `appId|agentId|conversationId|threadId` |
| `app_id`                     | text NOT NULL                      |                                                        |
| `agent_id`                   | text NOT NULL                      |                                                        |
| `conversation_id`            | text NOT NULL                      |                                                        |
| `thread_id`                  | text NULL                          | DMs are null                                           |
| `covered_through_at`         | timestamptz NOT NULL               | created_at of the newest message covered               |
| `covered_through_message_id` | text NOT NULL                      | its id (tie-break + precision)                         |
| `updated_at`                 | timestamptz NOT NULL DEFAULT now() |                                                        |


Surrogate `id` PK so the nullable `thread_id` works in upserts via `ON CONFLICT (id)`;
the sweep/extractor lookup keys on `(conversation_id, thread_id, agent_id)` (index
those). `agent_session_digests` and `memory_evidence` are unchanged.

## 7. Error handling / edge cases

- **First run (null watermark):** bounded recent read (as today); bootstraps the
watermark from the messages it covers.
- **Extraction failure:** the cursor is upserted **last** (after a successful digest
write), so a failure leaves it unmoved → retried next sweep (matches the existing
backoff model in `idle-session-sweep.ts`). No loss, no premature advance.
- **Message arrives mid-extraction:** watermark = max(created_at) of messages *read*,
so a later arrival is `> wm` → picked up next pass. No loss, no dup.
- **Timestamp ties:** read predicate is
`created_at > wm OR (created_at = wm AND id > wm_message_id)`.
- **Context turns** never affect the watermark (it is max over NEW only) and are never
extracted.
- `**precompact` trigger:** identical watermark logic.

## 8. Testing

**Unit**

- Watermark read: given messages + a watermark, returns only NEW (correct tie-break)
  - the context window; `covered_through` = max(created_at of NEW); empty NEW ⇒ skip;
  null watermark ⇒ bounded recent.
- Prompt payload marks context turns non-extractable.

**Integration (Postgres)**

- Extract a session ⇒ digest carries `covered_through_*`.
- Re-run with no new input ⇒ **zero** new evidence/digest (core anti-dup assertion).
- Add one message ⇒ only that message is extracted.
- New session on the same conversation ⇒ reads since the **conversation** watermark,
does not re-chew prior turns.
- Repeated-mention scenario (the 147-dup case) ⇒ each turn extracted once.

## 9. Verify phase (operator-run, end-to-end)

After implementation, with a clean DB:

1. Fast-test idle: the parser validates `idle_end_minutes` as an **integer 1–1440**
  (`runtime-settings-agents-parser.ts`), so a literal 30s isn't accepted as-is. Either
   (a) set `agents.boondi_support.memory.idle_end_minutes: 1` (the minimum; detection ≈
   1 min idle + one ~30s sweep poll), or (b) apply the optional validator-relaxation
   task in the plan to allow fractional minutes and set `0.5` (= 30s). Restart Gantry.
2. From a **new fake number**, send a message stating a fact Boondi should remember
  (e.g. a dietary constraint).
3. Wait for extraction (≈ idle threshold + one sweep poll). Confirm:
  - `memory_evidence` has the fact **once** (no duplicates),
  - the digest carries `covered_through_at`/`covered_through_message_id`.
4. **Manually invoke `/dream`** for that conversation to consolidate into long-term
  memory. Confirm `memory_items` now holds the fact (scoped to that user_id).
5. Confirm the **LLM gets it from the dreaming table**: start a fresh turn and verify
  the injected context's consolidated-memory section (from `memory_items`, via the
   recall path) includes the fact — i.e. it is recalled from `memory_items`, not only
   the rolling digest.
6. Confirm the fact is **visible on the dashboard** Memory panel (the dashboard reads
  `memory_items` exclusively, so its appearance is itself proof the fact reached the
   dreaming table).
7. Re-send / continue the conversation and confirm **no new duplicate evidence** is
  created for the already-known fact (watermark + skip-known working together).

## 10. Rollout

Operator resets Postgres to empty → fresh schema includes the new
`memory_extraction_cursor` table (no backfill). Cursors bootstrap themselves on first
extraction per conversation. Dreaming runs nightly at 01:00. No backlog-cleanup or GC
code (per scope).

## 11. Success criteria

- Re-running extraction with no new customer input produces **no** new evidence rows.
- A fact stated once yields **one** evidence row, not a growing pile.
- After `/dream`, the fact is a single clean `memory_item`, recalled into the agent's
context and visible on the dashboard.
- Zero change to hydration/recall behavior beyond the data now being non-duplicated.

