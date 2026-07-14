# Goal Prompt: Company Brain Stage 2 — Channel Harvest + Brain Dreaming

## Objective

Give the company brain (Stage 1, PR #195, `docs/architecture/company-brain-core-goal-prompt.md`)
its first live feed and its metabolism:

1. **Channel harvest tap** — opted-in channel conversations flow into brain
   pages automatically (Slack is the first target, but the tap hooks the
   canonical inbound message path, not a Slack-specific one).
2. **Brain dream job** — a nightly batched LLM consolidation, modeled on
   `apps/core/src/memory/app-memory-dreaming.ts`, that turns raw harvested
   pages into durable knowledge: prose entity/edge extraction, entity page
   enrichment, thread distillation. This is where "harvest, not dump" happens.

Stage 1 shipped the store (pages/entities/edges/embeddings), retrieval,
synthesis, agent tools, and import. Today the brain only grows via
`gantry brain import` and `brain_write`, and the graph only wires from
frontmatter/wiki-links. After Stage 2 it grows from live conversation and
learns from prose.

Use ponytail. Keep the change surgical. No compatibility shims.

**Out of scope (later stages):** connector delta-pollers, subscriptions
table, Gmail/Jira sync, attention routing (waking agents on new items),
per-source read ACLs, multi-app scoping, auto-promotion of agent memories
into the brain, and destructive graph mutations (entity merge / page retire)
beyond logging proposals. Do not build placeholders.

## Required Behavior — Channel Harvest

- Harvest is **opt-in per channel/conversation, default off** (decision D7:
  the admin flip IS the disclosure decision). Config lives in `settings.yaml`
  on the channel/conversation config (e.g. `brain_harvest: true`), following
  the settings-control-plane rules: state whether Postgres projection is
  reconciled and which API/CLI/MCP surfaces expose the flag (read-only
  surfacing in status output is sufficient; no new admin UI).
- The tap hooks the **canonical inbound message path** (channel-neutral —
  the seam where inbound messages are persisted as canonical conversation
  messages), not `channels/slack/*`. Slack is simply the first channel whose
  config gets the flag; Telegram/Teams/Discord work identically.
- Page shape (bounded page count, deterministic slugs, idempotent re-writes):
  - Threaded messages append to one page per `(channel, thread)`:
    slug `chan-<conversation>-<threadId>`.
  - Unthreaded messages append to one page per `(channel, day)`:
    slug `chan-<conversation>-<YYYY-MM-DD>`.
  - Body is chronological `[sender at time] text` markdown; frontmatter
    accumulates `people:` from sender display names.
- New `sourceKind: 'channel'` on brain pages (extend the Stage 1 union;
  update the control/openapi surfaces that enumerate it).
- Harvest writes must be **zero-LLM and non-blocking for the message turn**:
  a failed harvest write logs a warning and never breaks message delivery.
- Harvest pages do **not** embed on write (volume); they are picked up by the
  existing brain embedding backfill cron. Agent `brain_write` and CLI import
  keep their Stage 1 embed-on-write behavior.
- A message in a non-opted-in channel must leave **zero rows** in brain
  tables.

## Required Behavior — Brain Dreaming

- New system cron job **Brain Dreaming** registered in
  `apps/core/src/jobs/system-jobs.ts` next to Memory Dreaming (nightly
  default, same enable/disable conventions as the existing dreaming and
  backfill jobs). It must honor the scheduler `AbortSignal` between items
  (same convention as the brain embedding backfill).
- Input cursor: pages created/updated since the last successful dream run
  (persist the cursor durably — a small brain state row or the job's
  metadata, following whatever the existing dreaming job uses). Per-run
  batch cap so cost is bounded.
- The dream calls the **memory LLM lane** (same client/profile the memory
  dreaming and Stage 1 synthesis use) and proposes operations in a strict
  JSON schema. v1 applies **additive operations only**:
  - `upsert_entity` (kind, name) — e.g. entities found in prose that
    frontmatter extraction missed ("Alice works at Acme" in a body).
  - `upsert_edge` (type, from, to, evidence page id) — typed edges grounded
    in an existing page.
  - `write_fact_page` — distill a thread/day page into a durable fact page
    (deterministic slug like `fact-<topic-slug>`, sourceKind `agent` is
    wrong here — use `dream`; extend the union) citing evidence page ids in
    frontmatter.
  - `enrich_entity_page` — create/update a per-entity summary page (slug
    `entity-<kind>-<normalized-name>`) accumulating what the brain knows.
  - Anything destructive the model proposes (merge entities, retire pages)
    is **journaled as a proposal, never applied** in this stage.
- Determinism and audit (memory-architecture-contract requirements):
  - Every applied or rejected operation is journaled in a
    `brain_dream_decisions` table (mirror the shape of
    `memory_dream_decisions`: run id, op json, outcome, reason, timestamps).
  - Operations are idempotent: entity/edge upserts ride the Stage 1 unique
    keys; fact/entity pages use deterministic slugs; re-running a dream over
    the same input produces no new rows (validate ops against schema before
    applying; invalid ops are journaled as rejected, never partially
    applied).
- Dream failures leave the cursor unadvanced so the next run retries; a
  partial batch advances only past pages whose ops were fully journaled.

## Implementation Shape

- Harvest tap: a small `apps/core/src/brain/brain-channel-harvest.ts`
  (compose via `brain-runtime.ts`, which owns cross-layer wiring — keep
  `apps/core/src/brain/` free of new direct adapter imports outside
  brain-runtime). Hook invocation from the canonical inbound persistence
  seam; read the opt-in flag from resolved runtime settings.
- Dreaming: `apps/core/src/brain/brain-dreaming.ts` (op schema, validation,
  apply, journal) + registration in `system-jobs.ts`. Reuse the memory LLM
  client port from Stage 1 synthesis (`memory-llm-port`); do not add a new
  credential or provider surface.
- Storage: migration **next number after current head** (0094 at time of
  writing — verify against the journal) adding `brain_dream_decisions` and,
  if needed, the dream cursor row. Update the migration-journal guard test
  (`apps/core/test/unit/storage/postgres-migration-journal.test.ts`) — the
  previous head's test anchors positionally and a new `at(-1)` guard is
  expected per migration (see the 0093 entry for the pattern).
- Settings: `brain_harvest` flag parsing in the settings/channel config
  parser + validation, surfaced read-only in status output. Follow the
  `settings-control-plane` and `schema-change` skills.
- Bounded write scope: `apps/core/src/brain/**`, the canonical inbound
  message seam (tap invocation only), `apps/core/src/jobs/system-jobs.ts`
  (registration), settings parser/validation files for the flag, storage
  schema/migration/repository for the journal table, docs, tests. Do not
  modify `apps/core/src/memory/**` behavior; reuse via imports only. Do not
  add Slack-specific logic to core runtime.

## Surface Impact Matrix

| Surface | Impact | Reason |
| --- | --- | --- |
| Runtime behavior | Changed | Inbound messages in opted-in channels write brain pages; nightly brain dream consolidates. |
| `settings.yaml` | Changed | New per-channel/conversation `brain_harvest` opt-in flag (default off); settings.yaml is source of truth, projection reconciled per settings-control-plane. |
| Postgres/runtime projection | Changed | `brain_dream_decisions` (+ dream cursor) migration; harvested pages/fact pages in existing brain tables. |
| Control API | Read-only/observable | Harvest flag and dream status visible via existing status/openapi surfaces; no new admin endpoints. |
| SDK/contracts | Unchanged by design | No provider SDK contract change; dream reuses the memory LLM lane. |
| CLI | Read-only/observable | `gantry brain status` gains dream/harvest counters; no new commands. |
| Gantry MCP tools/admin skill | Unchanged by design | Stage 1 tools already read everything the harvest/dream produce. |
| Channel/provider adapters | Unchanged by design | Tap hooks the canonical seam; no per-channel adapter changes. |
| Docs/prompts | Changed | This goal prompt; brain architecture doc updated with harvest+dream; settings docs for the flag with the D7 disclosure warning. |
| Audit/events | Changed | `brain_dream_decisions` journal is the dream audit trail; harvest writes log at debug/warn only. |
| Tests/verification | Changed | Unit + Postgres integration coverage below. |

## Acceptance Criteria

- Unit: harvest page shaping — threaded messages append to the thread page,
  unthreaded to the day page, slugs deterministic, second identical message
  append is idempotent; non-opted channel produces no write call.
- Unit: dream op schema — valid additive ops apply; destructive ops journal
  as proposals without applying; invalid ops journal as rejected; op
  application is idempotent (running the same op set twice adds no rows).
- Unit: dream with a stubbed LLM extracts a prose-only relation ("Alice
  works at Acme" with no frontmatter) into `works_at` edge + entities, with
  the source page as evidence.
- Integration (Postgres): end-to-end — write harvested thread pages via the
  tap path, run a dream batch with a stubbed LLM, assert: entities/edges
  exist, a fact page cites evidence page ids, `brain_dream_decisions` rows
  journal every op, cursor advanced; re-run the same dream input → zero new
  rows and journaled no-ops; abort signal between items stops the batch and
  leaves the cursor retry-safe.
- Integration: embedding backfill picks up harvested pages (pending →
  ready).
- Settings: parsing/validation round-trip for `brain_harvest`, default off.
- Architecture check, file-size budgets, and migration-journal guard tests
  remain clean.

## Focused Verification

```bash
npm run test:unit -- apps/core/test/unit/brain/
npm run test:integration:postgres -- apps/core/test/integration/brain-harvest-dreaming.postgres.integration.test.ts
python3 .codex/scripts/check_architecture.py
```

Closeout pipeline:

```bash
npm run build
npm test
python3 .codex/scripts/check_task_completion.py
python3 .codex/scripts/validate_artifacts.py --allow-missing-run
python3 .codex/scripts/verify.py
```

Use disposable Postgres (pgvector image, `vector` + `pgcrypto` + `pg_trgm`
extensions in public schema) — never the developer's persistent database.
Add the new integration test file to the `test:integration:postgres` list in
`package.json` (Stage 1 forgot this; don't repeat it).

Runtime smoke after merge: enable `brain_harvest` on one test channel → post
a threaded conversation → page searchable via `brain_search` within a minute
→ trigger the Brain Dreaming job via `gantry jobs trigger` → entity/fact
pages exist and `brain_query` cites them → confirm a non-opted channel left
no trace → Knacklabs lead-gen smoke still passes.

## Assumptions

- Known pre-existing red on main: 2 `live-admission-work-items` integration
  tests + 1 `live-waiting-admission` metrics test fail on clean origin/main
  (provider-account id formats, post-#194); not regressions from this work.
- Brain remains single-app (`DEFAULT_MEMORY_APP_ID`) per Stage 1; the memory
  IPC signed scope still carries no app identity.
- Dream cost is bounded by batch cap × nightly cadence; no per-message LLM
  calls anywhere in the harvest path.
- Destructive graph maintenance (merge/retire) and dream-proposal review UX
  are Stage 2.5+ — the journal rows are their future inbox.
- Attention routing ("ticket assigned → wake agent") arrives with connector
  pollers (Stage 3) and is unrelated to this tap.
