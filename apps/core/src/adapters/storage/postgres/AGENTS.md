# Postgres Adapter Notes

- Provider session resume lookup must be scoped by the resolved canonical
  `agentId` plus route scope. Route-only keys can leak provider session or
  digest continuity after conversation or thread rebinding.
- Conversation route upserts that represent rebinding must update the active
  binding `agentId`; keeping the old owner active makes runtime session
  ownership checks meaningless.
- Legacy continuity rows that lack current `scope_key` and digest scope fields
  are inert unsupported data. Postgres repositories must not import, backfill,
  or repair them into current continuity.
- Production continuity job hydration must pass the current
  `AgentSession.appId` into scheduler job list filters so shared databases do
  not leak active or paused jobs across app scopes.
- Do not reintroduce the legacy domain `memory`, `jobs`, or `browserProfiles`
  properties on `PostgresDomainRepositoryBundle`; runtime memory and jobs use
  app-memory services and canonical job/session repositories, while browser
  runtime state remains outside this obsolete repository bundle.
- Repository adapters returning domain `IsoTimestamp` fields must normalize
  Postgres timestamp strings to ISO strings before crossing the adapter
  boundary.
- Drizzle may wrap Postgres `23505` unique violations under `cause`; retry or
  deterministic-upsert guards must inspect the wrapped cause instead of only
  the top-level error.
- Runtime events must be appended only through `PostgresRuntimeEventRepository`.
  Broker readiness belongs in `event_bus_outbox`; do not add direct
  `runtime_events` inserts, dual event tables, or retired event aliases.
- Scheduler jobs are background-only. Do not add `jobs.execution_mode`,
  serialized/parallel job modes, or repository DTO fields that project an
  execution mode; pg-boss scheduling uses one durable jobs queue and runtime
  concurrency is handled outside the persisted job shape.
- Scheduled job sessions may carry `jobId` for memory and execution context,
  but nested provider/session `agent-run:*` rows must not copy that `jobId`.
  Keep job-scoped run lists and health metadata tied to the scheduler lifecycle
  run row only.
- Conversation route projection must preserve the canonical conversation kind:
  `direct`/`dm` rows return runtime `conversationKind: "dm"` and group/channel
  rows return `conversationKind: "channel"`. Do not infer DM-vs-group memory
  scope from trigger settings or binding memory-subject blobs.
- JSON-shaped runtime payload columns that are queried, indexed, validated, or
  partially updated belong in native `jsonb`. Pass objects/arrays to Drizzle
  `jsonb` columns, keep canonical route/lease/audit/join fields typed, and do
  not add `::jsonb` casts around columns that are already `jsonb`.
