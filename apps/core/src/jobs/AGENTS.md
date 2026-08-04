## Scheduler Job Runtime Notes

- Host-owned system jobs do not have child-runner heartbeats. They must carry
  explicit abortable deadlines through `handleSystemJob` into any subsystem
  work they start, and their `timeout_ms` must include only intentional
  finalization grace beyond the subsystem's own durable lease.
- Scheduled jobs that use the canonical `Browser` capability must close the
  derived per-conversation browser profile after terminal run settlement. The
  close path should release browser tool backends and the Chrome session, then
  emit a `job.tool_activity` cleanup event so operators can verify that browser
  IPC did not leave a profile running after the job completed or failed.
- Agent-originated Gantry MCP tools that mutate durable runtime state must cross
  the signed host IPC boundary. Do not open Postgres repositories, artifact
  stores, or runtime storage directly from the MCP subprocess; add a typed IPC
  handler and inject runtime stores through `IpcDeps`.
- Agent task lifecycle IPC owns `todo_update` as an ephemeral channel render
  signal; do not add Postgres lifecycle rows for display-only todo state. Async
  command task IPC may exist only when it is backed by the full durable
  `agent_async_tasks` lifecycle: admission before execution, a real host
  executor, scoped read/list/cancel, abort propagation, terminal receipts, and
  restart recovery. `delegate_task` uses the same durable row before spawning a
  child Gantry agent run; `task_message` persists steering before delivering it
  through runner continuation input. Dormant unavailable handlers are not a
  product surface.
- Scheduler terminal notifications are user-facing lifecycle receipts. Format
  job reports, system maintenance results, and next-run times into readable
  product copy before delivery; never surface raw queue bookkeeping JSON,
  runner diagnostics, or ISO timestamps as the primary outcome.
- Live scheduler notification evidence is part of terminal settlement. When a
  live run stamps `notified_at`, pass the lease token that finalized the run and
  fail if the repository rejects it; recovery-only timeout notification paths
  may stamp after stale lease release because no live worker still owns the run.
- System maintenance jobs must own their runtime budget explicitly. Include
  timeout constants in the registration signature so existing canonical jobs are
  updated, and pass the remaining deadline through maintenance queues into the
  actual subsystem instead of relying on stale-lease recovery as the timeout.
- `__system:` prompts and `system:` job ids are host-reserved. User and agent
  job create/update paths must reject them, and scheduler admission/execution
  must use trusted system job identity instead of prompt text alone.
- `request_skill_install` has two distinct IPC outcomes: staged `files` go
  through same-channel approval and, on approval, immediately install, bind,
  sync settings, and return immediate skill context; `installCommandArgv`
  without files goes through the same approval, then runs the exact argv in a
  temporary staging directory with scrubbed env, imports the produced
  `SKILL.md` package, binds it, syncs settings, and returns immediate
  skill context.
- Job notifications are user-facing lifecycle receipts. Lead with the result,
  then give one next action only when needed. Keep raw tool ids, task ids,
  queue diagnostics, exact repair commands, and logs in details/audit paths
  instead of the primary channel message.
- Runner startup diagnostics (`run.startup_diagnostic`) are details/audit data
  for operators. Scheduled jobs may forward and summarize them into terminal
  run diagnostics, but notification copy must not dump raw timing payloads,
  prompts, URLs, tokens, tool args, or queue bookkeeping.
- Memory dreaming job notifications should be quiet on success: use a one-line
  completed outcome unless there are pending reviews, newly sent review items,
  blockers, timeouts, or failures. Keep review issues visible and actionable
  with user-facing guidance, and keep raw tool ids such as
  `memory_review_pending` out of the primary notification action.
- pg-boss `startAfter` accepts a `Date` or an ISO string ending in `Z`; persisted
  Postgres timestamptz strings such as `2026-05-19 04:00:00+00` must be
  converted to `Date` before `boss.send`, or pg-boss treats them as intervals.
- Scheduler run metadata must persist the execution provider id at claim time
  and update provider run handles when `runAgent` exposes the host/provider
  handle. Preserve the existing rule that streamed job `newSessionId` values are
  not written back into the job-owned session scope unless that product decision
  changes explicitly.
- Final forced provider metadata persistence is a correctness boundary. If the
  final flush cannot persist `provider_run_id` or `provider_session_id`, fail
  the run path loudly instead of logging and continuing with missing resume
  metadata.
- `request_permission` tool input is agent-authored and must not register
  arbitrary semantic capability definitions. Selected skill action definitions
  are trusted only when the host runner IPC includes them from materialized,
  selected skill metadata; local CLI definitions project only after pinned
  executable identity, preflight, protected paths, denied environment
  overrides, and reviewed command templates are present.
- Locked agent preset (`agents.<id>.access.preset: locked`) is enforced
  parent-side at two gates: `processTaskIpc` (`ipc-handler.ts`) for
  authority-changing/request/admin/settings IPC task types, and
  `processPermissionInteractionIpc` (`runtime/ipc-interaction-processing.ts`)
  for the `permission-requests` ingestion path — the permission gate runs
  before `recordPendingInteractionRequested`, so a locked agent can never
  create a pending interaction row, render a prompt, or receive a transient or
  persistent grant. Both gates deny with code `denied_by_profile` and a
  `permission.denied` audit event. Lock status is tri-state
  (`resolveAgentLockStatus`: locked | full | unknown); an unreadable settings
  desired state fails closed on these authority-bearing paths only (audit
  payload `accessPreset: 'unknown'`), never on ordinary non-authority task
  types. This is the security boundary — a forged IPC file in a locked agent's
  runner workspace is denied even though the child never mounted the tool. The
  denied task-type set is derived in `config/profiles.ts` from
  `AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES` (with `request_access` mapped to its
  `request_permission` IPC type) plus `ADMIN_MCP_TOOL_NAMES`; do not hardcode a
  parallel list. Child-side mount hardening (`GANTRY_AGENT_ACCESS_PRESET`) and
  the `permissionMode: 'deny'` auto-deny are defense-in-depth, not the boundary.
