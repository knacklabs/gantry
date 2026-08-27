# Review brief — lite window Q-0097 (remove the dead openBrowserSession scheduler dependency)

Facts: Q-0096 deleted the eager scheduled-job Chrome prelaunch, the only caller of `SchedulerDependencies.openBrowserSession`.

Contract for this diff (pure deletion + one comment):
- `openBrowserSession` removed from `SchedulerDependencies` and its wiring in `runtime-services.ts`; `ensureBrowserReady` import kept only if still used there.
- `execution-browser-cleanup.ts`: comment no longer refers to "the profile prelaunch opened"; no code change.
- No behaviour change anywhere.

Focus: no remaining reference to the removed field; nothing else in runtime-services depended on the removed import. Ignore style.
