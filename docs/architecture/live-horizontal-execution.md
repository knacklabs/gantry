# Live Horizontal Execution

Durable, multi-worker ownership for live interactive turns. Builds directly on
the job-worker coordination primitives (`run_leases`, `run_slots`,
`pending_interactions`, fencing versions) documented in
[multi-worker-execution.md](./multi-worker-execution.md), so live message
admission, continuation, stop, timeout, recovery, and prompt routing become
durable and routable across workers instead of living in process memory.

`runtime_events` remain observable output only. Durable continuation/stop/
prompt routing uses the live-turn command inbox, never runtime events.

## Scope identity

A live turn is the cross-worker ownership record for one interactive
conversation turn, keyed by the deterministic scope
`(appId, agentSessionId, conversationId, threadId)`. `makeLiveTurnScopeKey`
(`apps/core/src/domain/ports/live-turns.ts`) URI-encodes each component so
delimiter characters in ids cannot collide two scopes, and null/blank optional
components normalize to one key.

## Schema

Postgres tables (`apps/core/src/adapters/storage/postgres/schema/live-turns.ts`,
migration `0076_live_interactive_execution.sql`):

- `live_turns` — one ownership row per scope: scope key, scope components, the
  current `run_id`, `state`, durable `pending_message_json`, durable
  `stop_alias_jids_json`, `required_continuation_user_id`, `retry_count`, the
  per-turn `next_command_seq` allocator, and the current owner projection
  (`worker_instance_id`, `lease_token`, `fencing_version`). A **partial unique
  index** on `scope_key WHERE state NOT IN (terminal)` enforces one non-terminal
  live turn per scope; concurrent claimers lose via unique violation.
- `live_turn_commands` — the owner inbox. Each row carries a `command_type`
  (`continuation | stop | close_stdin | new_session | compact |
interaction_resolved`), a repository-allocated `seq`, an `idempotency_key`
  (unique), payload, `status` (`pending | applied | rejected`), and the fence
  snapshot at append time. A unique `(live_turn_id, seq)` index plus the
  row-locked `next_command_seq` allocation guarantee strict per-turn ordering.

## States

`live_turns.state` maps to the exact visible vocabulary:

| State                  | Visible label    | Meaning                                                  |
| ---------------------- | ---------------- | -------------------------------------------------------- |
| `claimed`              | Worker waking    | scope + slot + lease acquired, runner not yet registered |
| `running`              | Running          | owner registered the live runner and is heartbeating     |
| `awaiting_interaction` | Needs permission | a durable permission/question interaction is pending     |
| `setup_required`       | Setup needed     | deterministic capability/setup blocker                   |
| `recovered`            | Recovered        | a new worker safely claimed an expired live lease        |
| `completed`            | Completed        | fenced owner completed the live run                      |
| `failed`               | Failed           | fenced owner failed, stopped, or could not recover       |
| `timed_out`            | Timed out        | lease/recovery policy timed out without a valid owner    |

`completed | failed | timed_out` are terminal.

## Lease lifecycle

`apps/core/src/application/live-turns/live-turn-lease-service.ts` reuses the job
primitives:

1. **Admission** (`claimLiveTurnExecution`): acquire a `run_slots` slot under the
   `live:messages` key (cluster-wide live concurrency, replacing the
   process-local counter), claim the live turn for the scope, claim the
   `run_leases` lease (`job_id = null`), then project the lease onto the turn.
   A `scope_active` result means another turn already owns the scope — the
   caller routes a continuation instead of starting a duplicate runner. Slot
   holders are scoped to the lease generation (`turnId:fencingVersion`) so a
   stale owner releasing its hold cannot free a recovering owner's slot.
2. **Heartbeat** (`heartbeatLiveTurnLease`): renew lease + slot together; either
   loss is ownership loss.
3. **Finalize** (`finalizeLiveTurnExecution` → `finalizeLiveTurnWithLease`):
   settle the run lease (token + worker + fencing fenced) and write the terminal
   turn state in one transaction. A stale owner whose run was recovered gets
   `false` and writes nothing.
4. **Recovery** (`recoverLiveTurnExecution`): reclaim the run lease at a strictly
   higher fencing version, hold a slot under the new generation, and stamp the
   turn `recovered`. Late writes from the old owner are fenced out by
   `run_leases`.

## Routing and the owner inbox

`apps/core/src/runtime/live-turn-routing.ts` appends durable commands; any worker
can receive channel traffic:

- **Continuation**: a follow-up message for an active scope appends a
  `continuation` command (idempotent on the message identity), preserving the
  durable `required_continuation_user_id` check.
- **Stop / close-stdin**: `/stop`, stop aliases, and end-of-input resolve the
  scope (or a durable stop alias) and append a `stop` / `close_stdin` command.

`apps/core/src/runtime/live-turn-command-pump.ts` is the owner-side consumer: it
drains pending commands in `seq` order and applies each to the local runner
(IPC continuation write, stdin close, stop). **Apply marking is fenced by the
owner's run lease** — a stale owner cannot consume a command the recovered owner
must deliver. The drain is a serialized chain, so a command appended right
before a drain request is always observed.

`apps/core/src/runtime/live-turn-authority.ts` is the per-worker adapter that
owns admission, the local runner-hook registry, the ownership tick (renew lease

- slot, stop the local runner on ownership loss), and fenced finalization.

## Horizontal execution + recovery coordinator

Live execution is distributed: message polling, NEW live-turn admission, and
owned-turn execution run on EVERY live-capable worker
(`apps/core/src/app/bootstrap/live-execution.ts`
`buildLiveAdmissionProcessor`/`startLiveExecutionServices`). There is no lease
gate on polling or admission. The durable one-active-turn-per-scope claim
(`uq_live_turns_active_scope`) is the only serialization point: when two pollers
race the same scope, the loser routes its message to the owning turn's command
inbox instead of starting a second run. `runtime.live_turns.enabled` stays the
global feature flag.

Orphan-run avoidance: admission does a cheap `getActiveLiveTurn(scope)`
pre-check before minting an `agent_run`. If a turn is already active the
continuation routes without creating a run row at all; for the residual race
(claimed between pre-check and claim) the just-created run is terminal-marked, so
no non-terminal orphan run survives a lost race.

Per-worker capacity: each live worker bounds concurrency with its own slot key
`live:messages:<workerInstanceId>` (capacity `runtime.queue.max_message_runs`).
A worker at capacity returns `no_capacity` and leaves the message re-pollable;
another worker with free capacity claims the same scope next tick.

The singleton advisory lease `runtime:live-recovery-coordinator:default`
(`apps/core/src/app/bootstrap/live-recovery-coordinator.ts`) elects ONLY the recovery
coordinator. It gates startup pending-message recovery and the periodic recovery
sweep — nothing else.

- **Standby:** a worker that loses the coordinator-lease race still polls,
  admits, and executes live turns. It retries acquisition with bounded jittered
  backoff (no throw, no crash loop); it just does not run the recovery sweep.
- **Takeover:** when the holder drains it releases the lease early; a standby
  acquires it and starts the recovery coordinator (`startLiveExecutionServices`
  wires the lease transitions), including pending-message recovery for messages
  the previous coordinator never processed. Recovered turns resume ON the
  coordinator under a strictly higher fencing version; if the coordinator lacks
  slot capacity for a turn, that turn defers to the next sweep.
- **Lease loss:** the holder stops only its recovery coordinator in-process and
  re-enters standby acquisition. Its polling/admission keep running. Active turns
  are never torn down — they run under their fenced per-turn `run_leases` until
  they finish or the recovery sweep on the new coordinator reclaims them at a
  higher fencing version.

## Prompt durability across adapter restart

`pending_interactions` is still created before a permission/question prompt
renders. On resolution, the durable record is resolved first; then
`resolvePendingInteractionRecord`
(`apps/core/src/application/interactions/pending-interaction-durability.ts`)
appends an `interaction_resolved` command to the live turn that owns the run, so
the current (possibly recovered) owner consumes it and continues. Replayed
callbacks resolve nothing and append nothing.

## Recovery sweep

`apps/core/src/runtime/live-turn-recovery.ts` runs a bounded sweep over
`listRecoverableLiveTurns` (turns whose run lease is no longer active, plus
never-leased claims idle past a threshold). Each is reclaimed at a higher
fencing version and resumed; a resume failure settles the turn `failed` under
the new lease, and unleased stale claims are settled `timed_out` so their scope
frees up.

## Non-goals

- No new `settings.yaml`, CLI, MCP, or admin authority surface. Live runtime
  facts live in Postgres, not desired state.
- `runtime_events` stay observable output; they are never a command bus.
- Scheduled job execution stays on the existing job lease path.

## Acceptance gates

`apps/core/test/integration/live-horizontal-execution.integration.test.ts`:
one-active-turn enforcement, guarded/fenced state transitions, repository-
allocated command sequencing, idempotent/rejected appends, single-shot apply,
fenced finalize, recovery takeover at a higher fence, unleased-stale timeout,
and prompt-resolution delivery to the recovered owner. Unit coverage:
`apps/core/test/unit/domain/live-turn-scope-key.test.ts`,
`apps/core/test/unit/application/live-turn-lease-service.test.ts`,
`apps/core/test/unit/application/pending-interaction-durability.test.ts`,
`apps/core/test/unit/runtime/live-turn-routing.test.ts`,
`apps/core/test/unit/runtime/live-turn-command-pump.test.ts`,
`apps/core/test/unit/runtime/live-turn-recovery.test.ts`,
`apps/core/test/unit/runtime/live-turn-authority.test.ts`.
