# Postgres Live Hot Path Performance Goal Prompt

> Status: next goal prompt.
>
> Run this before `docs/architecture/live-useful-answer-latency-goal-prompt.md`.
> The useful-answer latency goal depends on this proof because the current
> launch risk is database hot-path behavior under many concurrent live turns.

```text
/goal Prove and harden Gantry's Postgres live hot paths for 300+ concurrent user-facing agents, with evidence-backed indexes, query plans, retention boundaries, and provider/runtime persistence measurements across live admission, runtime events, event outbox, sessions, DeepAgents checkpoints, MCP surfaces, and memory recall.

This is an implementation goal. Make code, tests, docs, benchmark artifacts, and verification changes as needed. Do not stop at a design summary. Start by converting this prompt into acceptance criteria and a capability-driven task decomposition.

Primary launch call:
- Postgres remains the launch source of truth for live runtime state, events, outbox rows, session metadata, DeepAgents checkpoints, memory recall, and benchmark evidence.
- Do not add Redis, SQS, Kafka, Redis Streams, a cache provider, a queue-provider selector, or a broker selector as the first fix.
- `LISTEN/NOTIFY` stays wake-up-only. Durable rows and replay stay authoritative.
- `runtime_events` stays observable-only and must not become command authority.
- `event_bus_outbox` is the only future broker boundary. If measured Postgres pressure still fails launch gates after bounded query/index/retention work, add a provider-neutral dispatcher adapter behind `event_bus_outbox` with Postgres as default and SQS/Kafka/Redis Streams as future implementations. Do not move live-turn ownership, approval authority, session resume, or checkpoint state to a broker.
- Anthropic SDK live continuity remains SDK-owned through `persistSession` plus explicit captured-session `resume`, with Gantry-owned `agent_sessions` and `provider_sessions` metadata. Do not replay transcripts or rely on directory-global `continue`.
- DeepAgents live continuity remains the official LangGraph Postgres checkpointer (`@langchain/langgraph-checkpoint-postgres` `PostgresSaver`) keyed by Gantry session/thread identity. Do not introduce SQLite, `MemorySaver`, JSON session files, a custom saver, or transcript replay.
- Performance fixes must be provider-driven only when there is a proven provider boundary. For this goal, the provider boundary is "Postgres default, optional future event-dispatch adapter behind outbox if evidence forces it", not a new cache/broker product surface.

Official documentation checkpoints to reread first:
- PostgreSQL indexes overview: https://www.postgresql.org/docs/current/indexes.html
- PostgreSQL multicolumn indexes: https://www.postgresql.org/docs/current/indexes-multicolumn.html
- PostgreSQL partial indexes: https://www.postgresql.org/docs/current/indexes-partial.html
- PostgreSQL index-only scans and `INCLUDE`: https://www.postgresql.org/docs/current/indexes-index-only-scans.html
- PostgreSQL `CREATE INDEX` and concurrent build behavior: https://www.postgresql.org/docs/current/sql-createindex.html
- PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED`: https://www.postgresql.org/docs/current/sql-select.html
- PostgreSQL `LISTEN`/`NOTIFY`: https://www.postgresql.org/docs/current/sql-notify.html
- PostgreSQL `EXPLAIN`, `EXPLAIN ANALYZE`, and buffers: https://www.postgresql.org/docs/current/using-explain.html
- PostgreSQL `pg_stat_statements`: https://www.postgresql.org/docs/current/pgstatstatements.html
- PostgreSQL autovacuum and routine vacuuming: https://www.postgresql.org/docs/current/routine-vacuuming.html
- PostgreSQL BRIN indexes: https://www.postgresql.org/docs/current/brin.html
- PostgreSQL `pg_trgm`: https://www.postgresql.org/docs/current/pgtrgm.html
- pgvector indexing: https://github.com/pgvector/pgvector
- Anthropic Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Anthropic Agent SDK session storage: https://code.claude.com/docs/en/agent-sdk/session-storage
- Anthropic Agent SDK hosting: https://code.claude.com/docs/en/agent-sdk/hosting
- Anthropic Agent SDK ToolSearch: https://code.claude.com/docs/en/agent-sdk/tool-search
- Anthropic Agent SDK observability: https://code.claude.com/docs/en/agent-sdk/observability
- DeepAgents production guidance: https://docs.langchain.com/oss/javascript/deepagents/going-to-production
- DeepAgents backends: https://docs.langchain.com/oss/javascript/deepagents/backends
- DeepAgents memory: https://docs.langchain.com/oss/javascript/deepagents/memory
- DeepAgents tools/MCP: https://docs.langchain.com/oss/javascript/deepagents/tools
- LangGraph Postgres checkpointer: https://docs.langchain.com/oss/javascript/langgraph/add-memory

Mandatory repo truth before edits:
- `README.md`
- `WORKFLOW.md`
- `docs/FACTORY.md`
- `docs/QUALITY.md`
- `docs/architecture/current-verification-commands.md`
- `docs/architecture/runtime-components.md`
- `docs/architecture/live-latency-hardening-goal-prompt.md`
- `docs/architecture/live-useful-answer-latency-goal-prompt.md`
- `docs/decisions/2026-04-29-runtime-event-exchange.md`
- `docs/decisions/2026-05-12-event-bus-outbox-boundary.md`
- `apps/core/src/adapters/storage/postgres/schema/live-turns.ts`
- `apps/core/src/adapters/storage/postgres/schema/events.ts`
- `apps/core/src/adapters/storage/postgres/schema/runs.ts`
- `apps/core/src/adapters/storage/postgres/schema/sessions.ts`
- `apps/core/src/adapters/storage/postgres/schema/worker-coordination.ts`
- `apps/core/src/adapters/storage/postgres/repositories/live-admission-work-item-repository.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/live-turn-repository.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/live-waiting-admission-query.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/runtime-event-repository.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/event-bus-outbox.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/canonical-session-repository.postgres.ts`
- `apps/core/src/adapters/storage/postgres/repositories/worker-coordination-repository.postgres.ts`
- `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/checkpoint-setup.ts`
- `apps/core/src/adapters/llm/deepagents-langchain/runner/session-store.ts`
- `apps/core/test/harness/live-latency-benchmark.ts`
- `apps/core/test/integration/live-latency-benchmark.postgres.integration.test.ts`
- `apps/core/test/integration/deepagents-postgres-checkpoint.integration.test.ts`

Exact UX contract:
- Do not add new user-facing latency copy unless a missing state is proven.
- Reuse existing live status meanings:
  - `model_slow`: "Still working: waiting on the model."
  - `tool_slow`: "Still working: waiting on <tool/capability>."
  - `listener_degraded`: "Gantry is catching up after a delivery delay. Your message is saved."
  - `queued_capacity`: "Gantry is at live capacity. Your message is saved and will start when a worker is available."
- Database pressure may change status/readiness diagnostics and admin detail, not conversation authority or capability truth.
- Slow database work must never make Gantry drop user input, replay stale commands, skip approvals, use raw tools, or silently switch providers.

Known gaps to fix or prove closed:
1. Benchmark DB metric taxonomy is being corrected in LOCAL-38. Old `dbPoolWaitMs` and `lockWaitMs` names must not remain active benchmark metrics because they were operation elapsed-time aliases. Active evidence uses real `poolCheckoutWaitMs`, SQL `queryElapsedMs`, `transactionElapsedMs`, observed `pgLockWaitMs`, and `liveAdmissionClaimMs`; remaining slices must add lower-level pool/lock instrumentation rather than infer those waits from elapsed calls.
2. Current 300-concurrency benchmark is not row-volume-realistic enough. It must seed large historical and terminal data, not only 300 active admissions.
3. LOCAL-41 added a live admission claim EXPLAIN gate, LOCAL-42 added runtime event replay EXPLAIN evidence, LOCAL-43 added recoverable live-turn sweep EXPLAIN evidence, LOCAL-44 added event bus outbox due-claim EXPLAIN evidence, LOCAL-45 added provider-session resume/write EXPLAIN and 300-sample timing evidence, LOCAL-46 added DeepAgents official `PostgresSaver` checkpoint row-volume evidence, LOCAL-47 added memory recall row-volume evidence, and LOCAL-48 added MCP inventory/audit row-volume evidence.
4. Readiness and metrics do not expose enough Postgres pressure evidence. Add benchmark artifacts first; expose stable summaries only when they are useful.
5. DeepAgents checkpointing adds real DB write amplification. LOCAL-46 exercises official `PostgresSaver` setup/schema creation and measures load/write paths separately from model latency; remaining work is real live-run launch evidence.
6. Anthropic SDK DB cost is Gantry session/provider metadata, especially `setProviderSession` row locks and old-session cleanup. Measure hot-conversation contention.
7. MCP inventory/detail caches are currently process-local TTL Maps. LOCAL-48 proves current process-local cold/warm inventory, detail, call-schema, materialization, and audit lookup pressure without a durable cache; final live-run launch evidence still needs to observe multi-worker remote fanout under real traffic before revisiting durable cache persistence.
8. Runtime tables have unbounded row-growth risk: `runtime_events`, `event_bus_outbox`, `live_admission_work_items`, `live_turn_commands`, `run_leases`, `pending_interactions`, provider sessions, and DeepAgents checkpoint tables need retention and autovacuum expectations.
9. `getOldestWaitingLiveAdmission` joins `messages` to `live_turns` through `'conversation:' || lt.conversation_id`, which may block clean index use. Prove or rewrite before adding broad expression indexes.
10. `findActiveLiveTurnByStopAlias` queries a JSONB array with `@>` and has no GIN index. Prove whether it matters in live traffic; if it is rare/admin-only, reject the index explicitly.

Benchmark row-volume scenarios:
1. Live admission claim storm:
   - 300 concurrent conversations.
   - 12 workers.
   - claim batch size 25.
   - 100k existing `live_admission_work_items` across queued, deferred, expired claimed, completed, failed, and canceled states.
   - 100k terminal `live_turns`.
2. Stale/deferred reclaim:
   - mixed queued, deferred-due, deferred-future, claimed-expired, and claimed-live rows.
   - concurrent workers using `FOR UPDATE SKIP LOCKED`.
   - assert no duplicate claims and bounded lock wait.
3. Runtime event replay:
   - at least 1M `runtime_events`.
   - filters by app, run, job, session, event type, conversation/thread, and cursor.
   - startup diagnostic lookup by expected run ids.
4. Event outbox recovery:
   - at least 1M `event_bus_outbox` rows.
   - pending, failed, published, and exhausted mixes.
   - due claim/replay from the dispatcher query shape after locating the real dispatcher.
5. Session/provider resume:
   - many agent sessions and provider sessions per app/agent/conversation/thread.
   - same-provider resume, stale-session expiry, same-provider retry without resume, and provider-family/app scoping.
6. DeepAgents checkpoint:
   - official `PostgresSaver.setup()` in a disposable schema.
   - inspect generated tables and indexes after setup.
   - 10k sessions/threads.
   - fresh write, resume read, missing checkpoint, corrupt/wrong-thread failure, large payload, concurrent resumed threads.
7. MCP pressure:
   - cold and warm `mcp_list_tools`, `mcp_describe_tool`, and `mcp_call_tool` schema/detail lookup.
   - many selected servers/tools/pages and multiple worker processes.
   - prove process-local cache behavior before deciding on durable cache.
8. Memory recall:
   - large `memory_items` and `memory_item_embeddings` cardinality.
   - lexical-only, vector-ready, partial-vector, stale-vector, and provider/model/dimension filter cases.
   - prove actual lexical/vector candidate paths still bound reads, and record whether full-text/trigram/HNSW indexes are used or rejected by evidence.
9. Autovacuum and bloat:
   - churn admission, outbox, runtime event, lease, pending interaction, and checkpoint rows.
   - inspect dead tuple ratio, analyze freshness, and vacuum behavior.
10. Pool saturation:
   - run with DB pool max below worker concurrency.
   - prove actual pool checkout wait separately from query time.

Candidate index/query work, evidence required before adding:
1. Live admission claim:
   - Pre-LOCAL-41, the query ORed `queued`, due `deferred`, and expired `claimed` rows, ordered by `created_at, id`, and locked with `SKIP LOCKED`.
   - LOCAL-41 splits the candidate query into bounded queued, due-deferred, null-deferred, and expired-claimed branches, then locks only the final joined/limited rows with `FOR UPDATE SKIP LOCKED`.
   - Queued work and null-deferred capacity work remain FIFO by original message time. Due-deferred retry and expired-claimed stale-lease recovery use readiness/expiry time to build a bounded candidate window, then the final claim order remains original message time across that window.
   - Prove the old `idx_live_admission_work_items_due` and `idx_live_admission_work_items_claim_expiry` plans at seeded volume before replacing them.
   - If needed, split the OR into index-friendly branches or add partial indexes:
     - `state = 'queued'` on `(created_at, id)`.
     - `state = 'deferred' AND defer_until IS NOT NULL` on `(defer_until, created_at, id)`.
     - `state = 'deferred' AND defer_until IS NULL` on `(created_at, id)`.
     - `state = 'claimed' AND claim_expires_at IS NOT NULL` on `(claim_expires_at, created_at, id)`.
   - Reject any index that does not improve P95/P99 or scanned-row ratio.
2. Live turns:
   - Prove `getActiveLiveTurn`, `findActiveLiveTurnByRunId`, `listRecoverableLiveTurns`, worker active count, and stop-alias lookup.
   - LOCAL-43 splits `listRecoverableLiveTurns` into bounded lost-owner and unleased-stale branch candidates, adds partial indexes `idx_live_turns_recoverable_leased` and `idx_live_turns_recoverable_unleased`, and proves both branches at 100k `live_turns` rows. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/live-turn-recoverable-explain-itest/live-turn-recoverable-plan.json`.
   - LOCAL-43 observed `idx_live_turns_recoverable_leased` with nested-loop `run_leases_pk` checks for lost-owner candidates at ratio `3.96 <= 20`, and `idx_live_turns_recoverable_unleased` for stale unleased candidates at ratio `1 <= 20`.
   - Consider partial active indexes only after EXPLAIN:
     - active worker count by `worker_instance_id`.
     - active/recoverable sweep by `updated_at, id`.
     - partial GIN on `stop_alias_jids_json` only if stop-alias lookup is not rare.
   - For `getOldestWaitingLiveAdmission`, prefer query normalization over a broad expression index if the join expression is the real cost.
3. Runtime events:
   - Existing cursor indexes may already be correct. Prove with `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
   - LOCAL-42 proves the active replay cursor shapes at 1M+ `runtime_events` rows without a schema change. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/runtime-event-replay-explain-itest/runtime-event-replay-plan.json`.
   - LOCAL-42 covered app cursor, run, job, session, conversation/thread, and event-type filters; each used the expected `idx_runtime_events_*` cursor index with rows-scanned-to-returned ratio `1 <= 20`.
   - Consider composite diagnostic indexes such as `(app_id, run_id, event_type, event_id)` or `(app_id, event_type, run_id, event_id)` only if startup diagnostic replay scans too broadly.
   - Consider BRIN for append-only time/event-id history only when B-tree cursor indexes are insufficient or storage/write amplification is too high.
4. Event outbox:
   - Locate the real dispatcher/claim query before changing indexes.
   - Prove current `(status, next_attempt_at, created_at)` at 1M rows.
   - LOCAL-44 confirms there is no active dispatcher/claim repository today; it proves the documented future dispatcher branch claim shape without adding runtime dispatcher code.
   - LOCAL-44 seeds 1M+ `event_bus_outbox` rows across `pending`, `failed`, and `published`, and proves pending-due and failed-due branch claims use `idx_event_bus_outbox_claim_due` with rows-scanned-to-returned ratio `1 <= 20`. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/event-bus-outbox-claim-explain-itest/event-bus-outbox-claim-plan.json`.
   - Consider partial due indexes only if pending/failed rows are a small active subset.
   - Add retention/archive expectations for published/exhausted rows before launch.
5. Sessions and provider resume:
   - Prove existing provider-session resume indexes and `setProviderSession` transaction behavior.
   - LOCAL-45 adds `providerSessionReadMs` and `providerSessionWriteMs` to the 300-sample benchmark metric set, seeds 50k+ `agent_sessions` and 100k+ `provider_sessions`, and records `.factory/benchmarks/postgres-hot-paths/provider-session-resume-write-explain-itest/provider-session-300-metrics.json`.
   - LOCAL-45 measured provider-session read P95 `5 ms` and write P95 `20 ms` for 300 samples with `benchmark_observed` evidence. The synthetic benchmark remains readiness-failing until a real live-run launch artifact exists.
   - LOCAL-45 proves `idx_agent_sessions_owner`, `idx_provider_sessions_resume_lookup`, `idx_provider_sessions_agent_status_updated`, `provider_sessions_pkey`, and `idx_provider_sessions_agent_provider` at 50k+/100k+ session row volume. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/provider-session-resume-write-explain-itest/provider-session-plan.json`.
   - Do not add provider-specific schema defaults.
   - Keep app/agent/conversation/thread ownership as the lookup boundary.
6. Worker coordination:
   - Prove `run_leases`, `run_slots`, `pending_interactions`, `runner_control_events`, `runner_control_nonces`, and `transient_grants` query plans under churn.
   - Consider pending interaction `(app_id, status, created_at)` only if list-by-created order becomes hot.
7. DeepAgents checkpoint:
   - Inspect package-created schema. Do not create custom checkpoint tables.
   - LOCAL-46 proves the official `@langchain/langgraph-checkpoint-postgres` `PostgresSaver` package schema at 10k+ checkpoint rows without custom tables or indexes. Package setup creates `checkpoint_migrations`, `checkpoints`, `checkpoint_blobs`, and `checkpoint_writes`, with primary-key indexes only.
   - LOCAL-46 measured 300 samples through Gantry's current `DeepAgentSessionStore` path: checkpoint load P95 `66 ms` and checkpoint write P95 `46 ms`, both under the `250 ms` gate, with `benchmark_observed` evidence.
   - LOCAL-46 records representative EXPLAIN evidence for the installed package schema's latest checkpoint read, exact checkpoint read, checkpoint blob lookup, checkpoint write upsert, checkpoint blob upsert, and checkpoint writes upsert shapes; each plan uses package primary-key indexes with rows-scanned-to-returned ratios `<= 5`. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/deepagents-checkpoint-postgres-itest/deepagents-checkpoint-plan.json`.
   - Add indexes to official tables only if the library supports the change safely, EXPLAIN proves the gap, and tests prove setup/upgrade still works.
   - Measure per-run pool `max: 1` impact separately from model/tool latency.
8. MCP:
   - First measure process-local cache hit/miss, remote page count, tool/schema bytes, and multi-worker fanout.
   - LOCAL-48 seeds 21k `mcp_servers`, 4,220 `agent_mcp_server_bindings`, and 100k `mcp_server_audit_events`, measures 300 repository samples, 300 warm process-local inventory samples, and 300 audit append samples, and records cold `mcp_list_tools`, warm `mcp_list_tools`, `mcp_describe_tool`, and `mcp_call_tool` schema/audit diagnostics. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/mcp-inventory-audit-explain-itest/mcp-inventory-audit-plan.json`.
   - LOCAL-48 measured repository `queryElapsedMs` P95 `4.55 ms`, process-local `mcpInventoryWarmMs` P95 `5.16 ms`, and `mcpAuditAppendMs` P95 `1.22 ms`; all were under gate in the retained artifact.
   - LOCAL-48 adds `idx_mcp_servers_app_status_updated` for active server listing, adds `idx_mcp_server_audit_events_app_server_created` for server-scoped audit listing, drops the superseded shorter MCP server/audit indexes, and makes selected-server materialization explicitly app-scoped. Accepted MCP plans use `idx_mcp_servers_app_name`, `idx_mcp_servers_app_status_updated`, `idx_agent_mcp_server_bindings_agent_status`, `mcp_servers_pkey`, `idx_mcp_server_audit_events_app_created`, and `idx_mcp_server_audit_events_app_server_created`, with rows-scanned-to-returned ratios `<= 20`.
   - LOCAL-48 rejects a durable MCP cache for now because current Postgres lookups and process-local warm inventory pass gates; repeated multi-worker remote/schema fetches remain a follow-up product decision only if future live evidence proves them to be the blocker.
   - Do not add a durable MCP cache table unless the benchmark proves repeated remote/schema fetches are a launch blocker and a product owner accepts the persistence/invalidations.
9. Memory extensions:
   - Verify actual recall query shapes against current memory item and embedding indexes; record whether `pg_trgm`/full-text or pgvector HNSW paths are used or rejected by evidence.
   - LOCAL-47 seeds 100k `memory_items` and 100k `memory_item_embeddings`, measures 300 DB-only recall samples, and records lexical ranked recall, lexical fallback, no-query subject/update recall, hybrid lexical candidates, hybrid vector candidates, stale-vector filtering, and provider/model/dimension filtering evidence. Evidence artifact: `.factory/benchmarks/postgres-hot-paths/memory-recall-explain-itest/memory-recall-plan.json`.
   - LOCAL-47 measured `memoryRecallDbMs` P95 `5.7 ms` against the `200 ms` gate in the retained artifact. The accepted plans used existing `memory_items_active_unique`, `idx_memory_items_subject_updated`, and `idx_memory_item_embeddings_item` paths with rows-scanned-to-returned ratios `<= 12`; no new memory index was justified.
   - LOCAL-47 explicitly seeded visible stale-content-hash, wrong-provider, wrong-model, and wrong-dimension close-vector rows, then proved the filtered vector query returned `0` of those rows while returning valid rows.
   - Do not switch HNSW/IVFFlat or add more embedding indexes without build-time, storage, query-latency, and recall-quality evidence.
10. Retention and vacuum:
   - Add explicit retention expectations or maintenance jobs only for runtime evidence that can be safely pruned/archive-owned.
   - Do not delete audit-critical state without an owner, retention period, and test.

Metric definitions and gates:
- `poolCheckoutWaitMs`: time waiting for a DB client/query slot. Gate: P95 <= 50 ms, P99 <= 150 ms.
- `queryElapsedMs`: single SQL execution time. Gate: P95 <= 100 ms for hot lookup/claim/replay queries.
- `transactionElapsedMs`: begin-to-commit for claim/append/session/checkpoint writes. Gate: P95 <= 150 ms, except checkpoint writes may use the checkpoint gate below.
- `pgLockWaitMs`: observed Postgres blocking lock wait. Gate: P95 <= 25 ms, max <= 250 ms, zero deadlocks.
- `liveAdmissionClaimMs`: claim transaction time. Gate: P95 <= 50 ms at 300 concurrent conversations and 100k seeded work items.
- `runtimeEventReplayMs`: runtime event cursor replay page latency. Gate: P95 <= 100 ms at 1M rows.
- `outboxClaimMs`: due outbox claim latency. Gate: P95 <= 100 ms at 1M rows.
- `providerSessionReadMs` / `providerSessionWriteMs`: Gantry session/provider metadata operations. Gate: P95 <= 100 ms.
- `checkpointLoadMs` / `checkpointWriteMs`: official PostgresSaver timing. Gate: P95 <= 250 ms at 10k sessions, with no prompt/blob leakage in diagnostics.
- `mcpInventoryWarmMs`: process-local warm lookup. Gate: P95 <= 25 ms.
- `memoryRecallDbMs`: lexical/vector DB recall excluding embedding-provider latency. Gate: P95 <= 200 ms at seeded memory cardinality.
- `planIndexUsed`: expected index appears in JSON plan for every hot query unless BRIN/sequential scan is explicitly justified. Gate: true.
- `rowsScannedToReturnedRatio`: actual scanned rows / returned rows. Gate: <= 20 for bounded lookup/claim paths.
- `deadTupleRatio`: `n_dead_tup / greatest(n_live_tup, 1)`. Gate: <= 0.2 after churn or vacuum/analyze evidence explains recovery.
- `writeAmplificationDelta`: added indexes must not increase enqueue/append/session/checkpoint write P95 by more than 20 percent or 10 ms absolute unless the gain is documented and accepted.

Acceptance criteria:
1. Query inventory:
   - Every hot query above is listed with repository method, SQL shape, expected cardinality, existing indexes, candidate indexes, and owner.
   - Every rejected index includes a reason.
2. EXPLAIN artifact:
   - Store before/after `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` results under `.factory/benchmarks/postgres-hot-paths/<benchmarkRunId>/`.
   - Artifact includes plan name, table cardinality, index names, actual rows, buffers, execution time, and verdict.
3. Correct metrics:
   - Benchmark no longer labels operation elapsed time as pool or lock wait.
   - Pool checkout, SQL query time, transaction time, and lock wait are separate.
4. Row-volume benchmark:
   - Disposable Postgres benchmark seeds the scenarios above and reports P50/P95/P99.
   - Readiness-critical metrics come from repository/runtime/checkpointer evidence, not synthetic placeholders.
5. Postgres-first provider decision:
   - No Redis/SQS/Kafka/cache/broker provider is added unless a documented launch gate remains failing after Postgres index/query/retention work.
   - If a broker is required, the plan adds only an `event_bus_outbox` dispatcher provider with Postgres default and exact failover semantics; live-turn authority stays in Postgres.
6. Anthropic and DeepAgents:
   - Anthropic SDK session persistence/resume behavior remains unchanged and measured through Gantry metadata operations.
   - DeepAgents official PostgresSaver schema and timing are measured in disposable Postgres.
   - No custom saver, transcript replay, or raw provider filesystem discovery is introduced.
7. Retention/autovacuum:
   - Hot append/churn tables have explicit retention/vacuum/analyze expectations and tests or documented operational checks.
   - Audit-critical evidence is not pruned without explicit owner and retention period.
8. Verification:
   - Focused tests and benchmark artifacts pass.
   - Cleanup searches prove no unplanned provider/broker/cache shortcut or raw authority was introduced.
   - Run `autoreview` and `ponytail` after implementation and fixes.

Capability-driven task decomposition:
1. Instrument DB timing and plan capture:
   - Fix metric taxonomy in the benchmark harness.
   - Add helpers for `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`.
   - Verify with unit tests for metric classification and source trust.
2. Build row-volume seeders:
   - Seed live admission, live turns, runtime events, outbox, sessions, worker coordination, checkpoints, MCP pressure, and memory recall datasets.
   - Verify with disposable Postgres integration tests.
3. Live admission and live turns:
   - Prove or improve claim/reclaim/active/recoverable/waiting-status plans.
   - Add only evidence-backed indexes or query rewrites.
4. Runtime events and event outbox:
   - Prove replay and outbox claim plans at 1M rows.
   - Add retention/autovacuum expectations.
5. Sessions, Anthropic SDK metadata, and DeepAgents checkpoints:
   - Measure provider-session read/write/resume contention.
   - Inspect and benchmark official PostgresSaver tables.
   - Preserve provider/session correctness constraints.
6. Worker coordination and interactions:
   - Prove leases, slots, pending interactions, runner control events, nonces, and transient grants under churn.
7. MCP and memory extensions:
   - Benchmark MCP process cache and selected tool/schema pressure.
   - Prove memory lexical/vector query plans and record full-text/trigram/pgvector index decisions.
8. Readiness/status projection:
   - Add stable Postgres pressure summaries only if they are useful and bounded.
   - Do not add noisy or raw `pg_stat_activity` dumps to user-facing surfaces.
9. Docs, cleanup, and review:
   - Update architecture docs only for active behavior.
   - Run cleanup searches, `autoreview`, and `ponytail`.

Surface Impact Matrix:
- Runtime behavior: Changed. Hot-path queries, benchmark timing, and possibly evidence-backed indexes/query rewrites change launch behavior.
- `settings.yaml`: Unchanged by design. No new broker/cache/queue provider setting for the launch path.
- Postgres/runtime projection: Changed. Indexes, migrations, query plans, retention expectations, and benchmark artifacts may change.
- Control API: Read-only/observable unless stable DB pressure fields are added to status/readiness.
- SDK/contracts: Unchanged by design for public API. Anthropic/DeepAgents internal timing evidence may be extended.
- CLI: Read-only/observable unless `gantry status` or doctor gets stable Postgres pressure summaries.
- Gantry MCP tools/admin skill: Read-only/observable unless admin diagnostics expose stable Postgres pressure fields.
- Channel/provider adapters: Unchanged by design. No user-visible channel behavior changes except existing status copy if DB pressure delays a turn.
- Provider SDK/tool contracts: Read-only/observable. Anthropic SDK resume and DeepAgents PostgresSaver behavior are measured, not replaced.
- Docs/prompts: Changed. This goal and any behavior docs touched by implementation.
- Audit/events: Changed only for redacted timing/diagnostic fields. Runtime events remain observable-only.
- Tests/verification: Changed. Add row-volume Postgres tests, EXPLAIN gates, metrics unit tests, and benchmark artifacts.

Required verification:
- Use a disposable Docker Postgres database for DB-backed tests.
- Enable required extensions before migrations: `CREATE EXTENSION IF NOT EXISTS vector;` and `CREATE EXTENSION IF NOT EXISTS pg_trgm;`.
- Focused commands:
  - `npm run test:unit -- apps/core/test/unit/harness/live-latency-benchmark.test.ts`
  - `npm run test:unit -- apps/core/test/unit/storage/postgres-readiness.test.ts apps/core/test/unit/storage/postgres-migration-journal.test.ts`
  - `GANTRY_TEST_DATABASE_URL=postgres://<redacted>@127.0.0.1:PORT/gantry_test npm run test:integration -- apps/core/test/integration/live-admission-work-items.postgres.integration.test.ts apps/core/test/integration/live-waiting-admission.postgres.integration.test.ts apps/core/test/integration/runtime-event-outbox.postgres.integration.test.ts apps/core/test/integration/deepagents-postgres-checkpoint.integration.test.ts apps/core/test/integration/memory-embedding-backfill.integration.test.ts`
  - `GANTRY_TEST_DATABASE_URL=postgres://<redacted>@127.0.0.1:PORT/gantry_test npm run test:integration -- apps/core/test/integration/live-latency-benchmark.postgres.integration.test.ts`
  - `npm run build`
  - `npm test`
  - `python3 .codex/scripts/verify.py`
  - `python3 .codex/scripts/check_task_completion.py`
- After implementation and verification:
  - Run `autoreview`.
  - Run `ponytail`.
  - Fix accepted findings or document rejected findings with evidence.

Required cleanup searches:
- `rg -n "Redis|redis|SQS|sqs|Kafka|kafka|Redis Streams|broker selector|queue provider|cache provider" apps/core/src apps/core/test docs`
- `rg -n "dbPoolWaitMs|lockWaitMs|poolCheckoutWaitMs|queryElapsedMs|transactionElapsedMs|pgLockWaitMs" apps/core/src apps/core/test docs`
- `rg -n "EXPLAIN|ANALYZE|BUFFERS|FORMAT JSON|seq scan|Seq Scan|Index Scan|Bitmap" apps/core/src apps/core/test docs`
- `rg -n "PostgresSaver|MemorySaver|sessionStore|persistSession|resume|continue: true|fork|transcript replay|raw transcript" apps/core/src apps/core/test docs`
- `rg -n "CREATE INDEX|DROP INDEX|idx_live_|idx_runtime_events|idx_event_bus_outbox|idx_provider_sessions|idx_memory" apps/core/src/adapters/storage/postgres apps/core/test docs`
- `rg -n "mcp inventory|mcp_list_tools|mcp_describe_tool|mcp_call_tool|schema bytes|tool schema|cache hit|cache miss" apps/core/src apps/core/test docs`
- `rg -n "delete from runtime_events|delete from event_bus_outbox|truncate|retention|autovacuum|dead tuple|n_dead_tup" apps/core/src apps/core/test docs`

Final handoff must include:
- Query inventory table.
- Candidate index table with accepted/rejected decision and why.
- Before/after EXPLAIN artifact path.
- P50/P95/P99 benchmark table by scenario.
- Pool, query, transaction, and lock timing split.
- Write amplification table.
- Retention/autovacuum decision table.
- Anthropic SDK metadata timing results.
- DeepAgents PostgresSaver schema/timing results.
- MCP cold/warm/multi-worker result.
- Memory recall extension result.
- Provider decision: "Postgres-only launch" or exact reason an `event_bus_outbox` dispatcher provider became necessary.
- Cleanup search results and interpretation.
- Verification commands and results.
- `autoreview` result.
- `ponytail` result.

Definition of done:
- Gantry has evidence-backed Postgres query plans for the live user-facing hot paths at 300+ concurrent conversations and seeded production-like row volume.
- Every added index maps to a measured query and every rejected index has a reason.
- No hot bounded lookup/claim path silently falls back to unbounded sequential scans above 10k rows.
- Pool wait, lock wait, SQL time, and transaction time are measured separately.
- DeepAgents checkpoint and Anthropic SDK session metadata costs are visible and within gates.
- Retention/autovacuum expectations are documented for append/churn tables.
- No Redis/SQS/Kafka/cache-provider shortcut, raw provider continuity path, or raw tool authority is introduced.
```
