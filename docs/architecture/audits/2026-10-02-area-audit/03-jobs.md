Read-only audit: no files changed. Findings come from code and caller tracing; I did not run the scheduler.

1. **API and chat calculate schedules differently — parallel / UX**

   An interval job created through the API starts immediately; the same interval created through chat starts after one interval. Validation also differs: API creation accepts any nonempty cron expression, while chat validates it; chat accepts interval strings such as `1000junk`, while API creation rejects them.

   **Locations:** [job-schedule-planner.ts:38](../../../../apps/core/src/jobs/job-schedule-planner.ts#L38), [:73](../../../../apps/core/src/jobs/job-schedule-planner.ts#L73), [:117](../../../../apps/core/src/jobs/job-schedule-planner.ts#L117), and [schedule.ts:42](../../../../apps/core/src/jobs/schedule.ts#L42). API caller: [job-management-create.ts:51](../../../../apps/core/src/application/jobs/job-management-create.ts#L51); chat caller: [job-management-service.ts:103](../../../../apps/core/src/application/jobs/job-management-service.ts#L103).

   **Survive:** one schedule validator and calculator, retaining cron/date validation and strict numeric intervals. **Merge:** the API, initial-run, and resume branches. **Size:** small. **Risk:** choose the first-run policy explicitly; changing it moves execution time.

2. **Failed-run inspection can hide the caller’s failures — UX / over-complicated**

   The dead-letter tool fetches the newest 50 failures globally, then removes jobs the caller cannot see. Fifty newer failures elsewhere can therefore produce an empty result despite the caller having failures. Ordinary run listing already scopes before limiting.

   **Locations:** [job-management-read-queries.ts:134](../../../../apps/core/src/application/jobs/job-management-read-queries.ts#L134), [job-management-visibility-readers.ts:40](../../../../apps/core/src/application/jobs/job-management-visibility-readers.ts#L40), and [canonical-job-repository.postgres.ts:676](../../../../apps/core/src/adapters/storage/postgres/repositories/canonical-job-repository.postgres.ts#L676). Existing scoped query: [same repository:600](../../../../apps/core/src/adapters/storage/postgres/repositories/canonical-job-repository.postgres.ts#L600).

   **Survive:** database ownership filtering before the limit. **Delete/merge:** the separate global-fetch-and-filter path; express dead letters as scoped runs with a status filter. **Size:** medium story across repository contracts and adapters. **Risk:** preserve authorization and ordering.

3. **Cron has two timing authorities — parallel / over-complicated**

   Gantry calculates and stores a cron job’s next run, but pg-boss independently schedules its execution. The scheduler explicitly ignores changes to the stored cron timestamp. Developers maintain both mechanisms, while the API exposes the stored timestamp as “next run.”

   **Locations:** calculation [schedule-math.ts:23](../../../../apps/core/src/jobs/schedule-math.ts#L23); persistence [execution-finalization.ts:80](../../../../apps/core/src/jobs/execution-finalization.ts#L80), [:326](../../../../apps/core/src/jobs/execution-finalization.ts#L326); independent timer [scheduler-engine.ts:390](../../../../apps/core/src/infrastructure/pgboss/scheduler-engine.ts#L390); ignored timestamp [:438](../../../../apps/core/src/infrastructure/pgboss/scheduler-engine.ts#L438); API projection [app-identity.ts:150](../../../../apps/core/src/control/server/app-identity.ts#L150).

   **Survive:** canonical next-run state and the existing delayed pg-boss delivery path at [scheduler-engine.ts:406](../../../../apps/core/src/infrastructure/pgboss/scheduler-engine.ts#L406), so displayed and dispatched times share an authority. **Delete:** the separate recurring timer and cron-specific reconciliation. **Size:** medium story. **Risk:** preserve timezone, restart, missed-slot, and overlap behavior. I did not reproduce a misfire.

4. **IPC constructs the same job service four times — duplicate**

   Adding a service dependency requires repeating its wiring across scheduler handlers. Three constructors copy the same base dependencies; run-now repeats them again with queue/event additions.

   **Every copy:** [ipc-scheduler-create-handlers.ts:30](../../../../apps/core/src/jobs/ipc-scheduler-create-handlers.ts#L30), [ipc-scheduler-query-handlers.ts:27](../../../../apps/core/src/jobs/ipc-scheduler-query-handlers.ts#L27), [ipc-scheduler-mutate-handlers.ts:27](../../../../apps/core/src/jobs/ipc-scheduler-mutate-handlers.ts#L27), [:42](../../../../apps/core/src/jobs/ipc-scheduler-mutate-handlers.ts#L42).

   **Survive:** one shared IPC construction function, retaining creation notifications and run-now dependencies. **Merge:** the repeated base wiring. Keep HTTP’s distinct live getters at [routes/jobs.ts:134](../../../../apps/core/src/control/server/routes/jobs.ts#L134). **Size:** small, at most five files. **Risk:** preserve dependency timing and notification hooks.

5. **HTTP copies the existing job-control adapter — duplicate**

   The same session-field translation and trigger forwarding are maintained separately for HTTP and IPC.

   **Every copy:** HTTP [routes/jobs.ts:171](../../../../apps/core/src/control/server/routes/jobs.ts#L171), mapper [:202](../../../../apps/core/src/control/server/routes/jobs.ts#L202); shared IPC adapter [ipc-job-control.ts:55](../../../../apps/core/src/jobs/ipc-job-control.ts#L55), mapper [:41](../../../../apps/core/src/jobs/ipc-job-control.ts#L41).

   **Survive:** the exported adapter already used by IPC. **Delete:** HTTP’s private adapter and mapper; reuse the exported implementation from a suitable shared location. **Size:** small. **Risk:** retain HTTP’s lazy repository lookup.

6. **Unused priming service and model-default helper — dead**

   Developers maintain a priming service exercised only by its test, although production never calls it. A second unused helper hardcodes `opus` as a default execution-provider lookup.

   **Locations:** [job-priming-service.ts:17](../../../../apps/core/src/jobs/job-priming-service.ts#L17); only consumer [job-priming-service.test.ts:10](../../../../apps/core/test/unit/jobs/job-priming-service.test.ts#L10). Unused default helper [job-model-resolution.ts:86](../../../../apps/core/src/application/jobs/job-model-resolution.ts#L86); import/re-export [model-resolution.ts:10](../../../../apps/core/src/jobs/model-resolution.ts#L10), [:18](../../../../apps/core/src/jobs/model-resolution.ts#L18).

   **Survive:** live readiness and `resolveJobModel`; they have production callers. **Delete:** the priming file and its sole test, plus the unused default helper and re-export. **Size:** small, four files. **Risk:** none found within repo callers.

7. **Run-now reimplements existing dependency guards — duplicate**

   Missing control, events, and trigger-queue dependencies have identical checks and error messages in two modules.

   **Every copy:** [job-management-run-now.ts:21](../../../../apps/core/src/application/jobs/job-management-run-now.ts#L21), [:31](../../../../apps/core/src/application/jobs/job-management-run-now.ts#L31), [:43](../../../../apps/core/src/application/jobs/job-management-run-now.ts#L43); existing helpers [job-management-require.ts:9](../../../../apps/core/src/application/jobs/job-management-require.ts#L9), [:21](../../../../apps/core/src/application/jobs/job-management-require.ts#L21), [:33](../../../../apps/core/src/application/jobs/job-management-require.ts#L33).

   **Survive:** the existing shared helpers. **Delete:** run-now’s local copies and import the helpers. **Size:** small. **Risk:** none if refusal strings remain unchanged.

Already covered:

- covered by PERMFLOW-3: separate job execution and job-only outcome prompting — [execution.ts:53](../../../../apps/core/src/jobs/execution.ts#L53), [job-run-prompt.ts:7](../../../../apps/core/src/jobs/job-run-prompt.ts#L7).
- covered by PERMFLOW-4: setup/job-card machinery and recovered/capacity notices — [execution-notifications.ts:205](../../../../apps/core/src/jobs/execution-notifications.ts#L205), [:236](../../../../apps/core/src/jobs/execution-notifications.ts#L236), [scheduler-delay-notification.ts:94](../../../../apps/core/src/infrastructure/pgboss/scheduler-delay-notification.ts#L94).
- covered by MSG-2: separate durable-enqueue and direct-send notification paths — [delivery.ts:168](../../../../apps/core/src/jobs/delivery.ts#L168), [:224](../../../../apps/core/src/jobs/delivery.ts#L224).

**Value ranking:** 1 → 2 → 3 for user impact; then 6 → 5 → 4 → 7 for deletion opportunity.
