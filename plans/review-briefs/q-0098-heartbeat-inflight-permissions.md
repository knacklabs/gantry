# Review brief — lite window Q-0098 (runner heartbeat counts in-flight permission waits, not files)

Facts (live run abe4dbc4, 2026-08-26 14:47Z): the runner asked permission for a piped RunCommand; the host attached it to the durable job card and — by design — deleted the runner's IPC request file. The runner stayed blocked in `requestPermissionApproval` polling for a response (correct). `job-heartbeat.ts` derived `pendingPermissionRequests` from files (requests minus responses), so it reported 0 while blocked; the scheduled idle watchdog (`pendingPermissions === 0 && idle >= 10 min`) SIGKILLed the run while the card still waited on the human. The same count also feeds the host's pending-heartbeat lease extension.

Contract for this diff:
- `permission-callback.ts` keeps a module-level registry of in-flight waits (requestId → toolName), registered before the request file is written and removed in `finally` on every exit path.
- `job-heartbeat.ts` reports that registry; the file-scanning helpers are deleted.
- No host change, no watchdog change, deepagents lane untouched (separate follow-up if its client differs).
- BY DESIGN: a run blocked on a card decision now stays alive until the job timeout (the JOBPERM-1 ask-and-wait contract); the idle watchdog is for stalls, not for waits.

Focus: every exit path of the poll loop clears the registry; concurrent waits (batch coalescer) count correctly; nothing else read the deleted helpers. Ignore style.
