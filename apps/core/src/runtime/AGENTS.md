# Runtime Notes

- Live provider text deltas may contain only whitespace or leading whitespace.
  Runtime streaming must preserve those deltas until the channel stream buffer
  formats the complete visible text.
- MCP caller identity headers are opt-in per approved MCP server version via
  `config.callerIdentity`. Host spawn may inject a signed header only for
  HTTP/SSE MCP servers whose config requires it, using
  `application/mcp/mcp-caller-identity.ts` as the single signer/projection
  owner. Do not add server-name or provider-specific identity branches in
  `agent-spawn`.
- If a Claude provider resume handle returns `No conversation found with
session ID`, expire that provider session and retry the same turn once without
  `resume`. Do not surface the stale provider-handle failure as the user-facing
  answer when a fresh session can handle the turn.
- Pre-agent guardrails run after slash commands and trigger checks but before
  typing, prompt formatting, agent spawn, or tool materialization. Runtime code
  must stay policy-agnostic: route by response kind, pass through policy-owned
  inline system prompt appends, and inject a classifier only for policies that
  still take a classifier path. Keep business-specific copy/rules in
  application guardrail policies.
- The Claude CLI remote-control path was removed. Do not reintroduce direct
  provider-specific remote-control spawning in runtime; any future equivalent
  must be a provider-neutral application capability with explicit permission
  and adapter ownership.
- Prepared execution adapters may pass only narrowly allowlisted runner context
  through `agent-spawn`: provider config/model hints plus host-derived skill
  action metadata. IPC auth tokens, MCP paths, provider credentials, arbitrary
  caller env, and other authority-bearing env must stay host-owned or in the
  model credential runner-input lane.
- Runtime sandbox projection must keep read and write protections separate.
  Generated skill projections and reviewed local CLI credential paths may need
  read access for approved executions, but must remain write-protected.
- Reviewer-authorized memory review runs must bind live continuations to the
  same non-self sender that earned control-approver authority. Do not pipe mixed
  or different-sender channel batches into a run that has memory review decision
  tools available.
- Egress gateway socket resets are tunnel-level failures, not host-runtime
  failures. Every accepted client, direct upstream, and upstream-proxy socket
  must have an error listener before piping so routine `ECONNRESET` events do
  not escape as uncaught exceptions and trigger launchd restarts.
- Egress gateway preferred-port collisions are expected under concurrent local
  worker spawns. Keep the explicit fallback warning, but do not also log the
  handled `EADDRINUSE`/`EACCES` listen failure as a generic server error before
  the gateway has been registered.
- Runtime shutdown must be single-flight. Ignore duplicate SIGINT/SIGTERM
  signals once cleanup starts, stop IPC sockets before warm-pool worker
  teardown, and close egress gateways before storage so late CONNECT audit
  writes cannot hit an ended Postgres pool.
- Thread/topic ids on live permission prompts are routing scope. Persisted
  `Always allow` grants and selected capability runtime projection must use the
  parent conversation identity. Thread/topic ids may choose approval delivery
  and audit metadata, but must not create another permission scope.
- Generated `.llm-runtime` access failures are adapter-state failures. Surface
  actionable `.llm-runtime` guidance instead of returning raw `EACCES` as a
  generic runner-exited error.
- `runtime.runner.idle_timeout_ms` controls how long a live runner keeps stdin
  open for in-process continuations after output. A short value such as `2500`
  is useful for broad local regression suites because it frees active-run slots
  quickly, but it is not evidence about realistic warm follow-up retention. Use
  a bounded longer value such as `20000` for warm-retention latency checks, and
  keep the 30-minute default in mind when reasoning about production resource
  tradeoffs.
- Warm-pool runtime code must stay provider-neutral. `runtime/warm-pool-manager`
  may drive only the optional capability verbs (`prewarm`, `acquire`, `release`,
  `healthCheck`, `shutdown`); SDK, MCP, query-loop, and runner-specific details
  belong in the execution adapter.
- Warm-pool generic capacity and acquired/bound workers are separate lifecycle
  states. When a generic worker is acquired for binding, the manager must start
  replenishing generic capacity immediately and must not count that acquired
  handle as `genericAvailable` in inventory snapshots.
- Worker inventory snapshots are observability, not scheduling authority. Local
  snapshots may compose warm-pool inventory and queue counters in memory; do not
  add heartbeat persistence or dashboard aggregation in runtime code unless that
  slice explicitly owns the rate-limited write/read model.
- Worker inventory cache visibility should stay aggregate-only in runtime:
  expose prewarm status counts and cache-shape/status buckets, not worker ids,
  prompt payloads, provider credentials, or customer transcript data.
- `runtime.warm_pool.max_bound_workers` is the settings-owned cap for acquired
  warm workers. Enforce it before removing an idle generic worker from the
  pool; hitting the cap must leave persisted work schedulable instead of
  dropping inbound messages or silently exceeding the bound-worker limit.
- Generic warm workers are idle only after optional cache prewarm reaches an
  explicit status. Record `succeeded`, `skipped`, or `failed` on the handle;
  cache-prewarm failure must not discard an otherwise bind-ready worker, and
  cache probes need their own low concurrency bound separate from process
  prewarm.
- Target-size warm prewarm is capacity replenishment, not an all-or-nothing
  transaction. If one generic boot fails while siblings succeed, retain the
  successful workers, schedule replacement for the missing capacity, and throw
  only when every target boot fails.
- Prompt-cache shape keys describe cache-affecting runtime input, not every
  process-pool key dimension. Keep resume/session handles out of the cache
  shape while including the execution provider, credential profile, agent,
  model, prompt hash, tool surface, and MCP set. Non-Anthropic SDK cache
  behavior remains deferred until another provider adapter is prioritized.
- For the Anthropic SDK warm-pool path, generic worker `startup()` is only SDK
  runtime warmup. Provider prompt-cache prewarm is adapter-owned
  `prewarmCaches` work: one throwaway synthetic Agent SDK query per
  `cacheShapeKey`, with provider cache usage evidence, followed by destroying
  the synthetic runner. Keep this shape-level work deduped and refreshed by the
  runtime manager; do not turn it into one synthetic provider call per warm
  worker.
- Session-specific warm workers must boot `startup()` with the provider resume
  handle already in SDK options; `WarmQuery.query()` cannot add `resume` later
  at bind time. Keep resume handles out of prompt-cache shape keys and redact
  them from trace payloads, but do not strip them from session-specific
  `warmRunnerInput`.
- Do not route saved provider-session turns through the generic warm pool.
  A generic Anthropic warm worker has already called `startup()` without that
  resume handle, so a returning conversation must either pipe to its retained
  live worker or cold-spawn with `resume`; using a generic worker here causes
  warm-bind session mismatches and retry churn.
- Cold resumed message runs are one-shot. They may use IPC for permissions and
  runtime callbacks, but must not stay open as retained continuation workers
  after a customer-visible reply; otherwise a later inbound can sit pending
  behind a cold process while generic warm workers are still available.
- Sticky warm workers depend on live process state, not detached handle state.
  If a pooled worker reaches an idle boundary, keep it only while the runner
  process remains registered and release the pooled worker on process `close`.
  Postgres-loaded follow-up batches should pipe through `queue.sendMessage`
  before spawning another agent when the live runner accepts the continuation.
  A DB-drain run that successfully pipes a continuation into a pooled runner
  must hand active-run accounting to that live continuation; do not release the
  pooled worker in the drain-run `finally` path before the runner reports idle
  or closes.
- If a retained pooled worker rejects or cannot receive a socket continuation,
  treat that worker as unreachable before fallback spawning continues: release
  the pooled handle, clear retained process state, and cancel any preserved idle
  cleanup for the old process so it cannot terminate the replacement run.
- Socket continuation delivery is the authoritative live carrier. Continuation
  frames carry the message text directly, close frames close directly, and the
  runtime must not restore filesystem mailbox writes or runner polling as a
  fallback.
- Socket dispatchers must reserve per-connection in-flight slots before the
  first awaited handler, repository lookup, or binding validation. Otherwise the
  on-frame cap check can admit multiple long-running requests through the same
  connection before accounting catches up.
- Event-driven IPC cutover defaults must not reintroduce filesystem latency:
  socket transport is the only runtime transport and event-pipe debounce
  defaults to immediate wakeup. For warm-pool-eligible no-session runs, an empty
  pool should be filled and reacquired before considering any cold spawn path; do
  not encode background-prewarm-while-serving-cold as the steady-state contract.
- Conversation-owner claims are not enough by themselves. Customer-visible
  message sends must carry a `MessageSendOptions.ownership` token resolved from
  the current owner lease at processing/send time, so channel wiring can verify
  the lease version immediately before provider dispatch.
- Conversation-owner timing is settings-owned under `runtime.ownership`:
  `lease_ttl_ms`, `heartbeat_interval_ms`, `reconciler_interval_ms`,
  `reconciler_limit`, and `shutdown_claim_wait_ms`. Runtime wiring should read
  these through config getters instead of adding env-only knobs or local
  constants in app startup.
- Conversation-work dispatchers are shutdown-sensitive claim sources. After
  `close()`, they must ignore even already-captured notification callbacks and
  must not acquire new conversation-owner leases. If `close()` lands while a
  lease claim is awaiting storage, the completed claim must not enqueue local
  work.
- Conversation-work reconcilers are also shutdown-sensitive claim sources. If
  `close()` lands while a scan is awaiting storage, the completed scan must not
  claim leases or enqueue local work. If `close()` lands while a lease claim is
  awaiting storage, the completed claim must not enqueue local work.
- Conversation-work claim-gate cleanup must attempt every tracked owner-lease
  release before surfacing failure; one stuck release should not prevent other
  cleanly drained leases from being released before the shutdown drain fallback.
- Conversation-work claim gates must also reject a claim result if `close()`
  lands while the underlying repository claim is in flight. If that late result
  acquired a lease, track it for shutdown cleanup before rejecting it to the
  caller.
- `releaseTrackedLeases()` must wait for claim attempts that had already
  started before shutdown before it snapshots tracked leases; otherwise a late
  acquired lease can miss release cleanup and survive until the drain fallback
  or TTL expiry.
- That in-flight claim wait must be bounded. Normal storage claims should be
  included in clean release cleanup, but a stuck repository claim must not hold
  shutdown forever; remaining local owner rows can fall through to the
  draining/TTL fallback.
- Keep Postgres integration coverage for claim-gate shutdown cleanup: tracked
  leases should be released from `conversation_owner_leases` before the
  runtime marks remaining local owner rows draining.
- Outbound delivery recovery is also customer-visible provider send. It must
  ask `RuntimeApp.getMessageSendOwnershipToken()` immediately before
  `sendProviderMessage()` and pass the token through `messageOptions`; do not
  let recovery dispatch bypass the channel ownership fence.
- Third-party `mcp_call_tool` writes are side effects. Write/admin/execute-
  shaped raw MCP names must pass the current conversation ownership check before
  proxy execution; keep read-shaped calls hot-path cheap, and require explicit
  reviewed risk metadata before treating unknown raw names as safe writes or
  production-ready non-idempotent mutations.
