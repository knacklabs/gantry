# Review brief — lite window Q-0096 (delete the eager Chrome prelaunch for scheduled jobs)

Owner decision: scheduled jobs must not launch Chrome before the agent starts. The first Browser tool call already launches it lazily (IPC handler → ensureBrowserReady, which takes the profile lease). Measured cost of the eager path was ~1.6 s per run plus a pre-run pause path only it could trigger.

Contract for this diff (pure deletion):
- `prelaunchBrowserForJobRun` and its module are gone; `execution.ts` keeps the final-readiness pause path unchanged.
- `setupStateForBrowserPrelaunchFailure` and prelaunch-only blocker copy are gone; `browser_login_may_be_required` stays (other callers).
- `execution-browser-cleanup.ts` is intentionally untouched: its predicate (declared-or-used) still holds because `closeBrowser` on a not-running profile returns `not_running` cheaply, and the profile is conversation-scoped exactly as before.
- `SchedulerDependencies.openBrowserSession` remains declared for one more window (removed next); no caller.
- BY DESIGN: browser-launch failures now surface on the first Browser tool result (tool failure → notice row) instead of a pre-run setup pause. Accepted by the owner.

Focus: nothing else referenced the deleted symbols; the readiness pause path is byte-identical in behaviour; tests removed only prelaunch assertions. Ignore style.
