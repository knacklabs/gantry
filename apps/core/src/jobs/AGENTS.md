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
- Scheduler terminal notifications are user-facing lifecycle receipts. Format
  job reports, system maintenance results, and next-run times into readable
  product copy before delivery; never surface raw queue bookkeeping JSON,
  runner diagnostics, or ISO timestamps as the primary outcome.
- System maintenance jobs must own their runtime budget explicitly. Include
  timeout constants in the registration signature so existing canonical jobs are
  updated, and pass the remaining deadline through maintenance queues into the
  actual subsystem instead of relying on stale-lease recovery as the timeout.
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
- Memory dreaming job notifications must keep pending memory reviews visible
  and actionable with user-facing review guidance, even when the dream run times
  out or fails after creating review rows. Keep raw tool ids such as
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
