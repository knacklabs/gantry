## Scheduler Job Runtime Notes

- Scheduled jobs that use the canonical `Browser` capability must close the
  derived per-conversation browser profile after terminal run settlement. The
  close path should release browser tool backends and the Chrome session, then
  emit a `job.tool_activity` cleanup event so operators can verify that browser
  IPC did not leave a profile running after the job completed or failed.
- Agent-originated MyClaw MCP tools that mutate durable runtime state must cross
  the signed host IPC boundary. Do not open Postgres repositories, artifact
  stores, or runtime storage directly from the MCP subprocess; add a typed IPC
  handler and inject runtime stores through `IpcDeps`.
