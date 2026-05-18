## Scheduler Job Runtime Notes

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
- `request_skill_install` has two distinct IPC outcomes: staged `files` go
  through skill draft approval and, on approval, immediately approve, bind,
  sync settings, and return immediate skill context; `installCommandArgv`
  without files goes through the same approval, then runs the exact argv in a
  temporary staging directory with scrubbed env, imports the produced
  `SKILL.md` package, binds it, syncs settings, and returns immediate
  skill context.
- Job notifications are user-facing lifecycle receipts. Lead with the result,
  then give one next action only when needed. Keep raw tool ids, task ids,
  queue diagnostics, exact repair commands, and logs in details/audit paths
  instead of the primary channel message.
- pg-boss `startAfter` accepts a `Date` or an ISO string ending in `Z`; persisted
  Postgres timestamptz strings such as `2026-05-19 04:00:00+00` must be
  converted to `Date` before `boss.send`, or pg-boss treats them as intervals.
