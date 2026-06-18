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
  runtime state remains outside this obsolete repository bundle. Expose browser
  profile snapshots through narrow runtime storage fields/accessors instead.
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
- Run-history schema fields for execution providers are incomplete unless the
  runtime path that learns the provider run/session handle writes them through
  the canonical ops repository. Do not add `agent_runs` columns with only direct
  repository round-trip tests; cover live or scheduler call paths too.
- Execution provider id cutovers must update every persisted continuity surface
  in the same migration: `agent_runs.execution_provider_id`,
  `provider_sessions.provider`, and `provider_sessions.provider_ref_json`.
  Leaving provider session rows on the old id breaks live SDK resume even when
  canonical `AgentSession` rows still exist.
- `llm_profiles.response_family` stores the canonical API shape (`anthropic` or
  `openai`), not the route/provider adapter. Store OpenRouter-style details in
  route metadata or run execution-provider columns, never as a response family.
- Shared Postgres schema files must not carry provider-specific default values.
  Runtime insertion paths should pass the resolved execution provider id
  explicitly, while historical migrations may backfill concrete old values.
- Conversation route projection must preserve the canonical conversation kind:
  `direct`/`dm` rows return runtime `conversationKind: "dm"` and group/channel
  rows return `conversationKind: "channel"`. Do not infer DM-vs-group memory
  scope from trigger settings or binding memory-subject blobs.
- JSON-shaped runtime payload columns that are queried, indexed, validated, or
  partially updated belong in native `jsonb`. Pass objects/arrays to Drizzle
  `jsonb` columns, keep canonical route/lease/audit/join fields typed, and do
  not add `::jsonb` casts around columns that are already `jsonb`.
- Interrupted scheduler lease release must be scoped by the matching
  `agent_runs.lease_owner`; stale time-based release may reclaim expired leases,
  but restart cleanup must not release another worker's active run.
- `tool_catalog` is Gantry durable capability state, not a provider SDK tool
  manifest. Seed only Gantry-owned facade names such as `WebSearch`,
  `WebRead`, `FileSearch`, `FileRead`, `FileEdit`, `FileWrite`, and
  `AgentDelegation`, plus scoped `RunCommand(...)` permission rows. Do not seed
  provider-native rows such as `Read`, `Write`, `Bash`, `Agent`, `Glob`,
  `Grep`, or `WebFetch`; those belong inside execution adapter per-run harness
  projections.
- Display-only agent todo state is not Postgres lifecycle state. Do not add
  `todo_update` tables, delegated-task tables, provider task id correlation, or
  read/cancel indexes until a real delegated executor and read model exist.
