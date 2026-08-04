/**
 * Operational health and metrics evaluation for the unversioned `/healthz`,
 * `/readyz`, and `/metrics` endpoints. These are internal-only endpoints
 * consumed by the load balancer (liveness/readiness) and Prometheus (metrics);
 * ALB rules own external exposure. The logic here is dependency-injected so it
 * can be unit-tested without a live database or HTTP server.
 */
import { LIVE_TURN_SLOT_KEY_PREFIX } from '../../application/live-turns/live-turn-lease-service.js';
import { computeHostCapacityPlan, HOST_EXECUTION_SLOT_KEY_PREFIX, hostExecutionSlotKey, } from '../../shared/host-capacity.js';
import { snapshotOperationalErrors } from '../../shared/operational-error-counters.js';
export async function evaluateReadiness(deps) {
    const requirements = deps.requirements;
    const draining = deps.isDraining();
    let database = 'fail';
    let migrations = 'fail';
    try {
        await deps.query('SELECT 1');
        database = 'pass';
        const rows = await deps.query('SELECT count(*)::int AS applied FROM __drizzle_migrations');
        const applied = rows[0]?.applied ?? 0;
        migrations = applied >= deps.shippedMigrationCount() ? 'pass' : 'fail';
    }
    catch {
        // Connection-level failure or missing migrations table: both DB and
        // migration checks fail, which is the correct not-ready signal.
    }
    const settings = deps.settingsLoaded() ? 'pass' : 'fail';
    const checks = {
        database,
        migrations,
        settings,
        draining,
    };
    const failing = [];
    if (database !== 'pass')
        failing.push('database');
    if (migrations !== 'pass')
        failing.push('migrations');
    if (settings !== 'pass')
        failing.push('settings');
    if (draining)
        failing.push('draining');
    // Role `control`: at least one valid control API key must be configured.
    if (requirements.requiresApiAuthConfigured && deps.role === 'control') {
        const apiAuth = (deps.apiKeyCount?.() ?? 0) > 0 ? 'pass' : 'fail';
        checks.api_auth = apiAuth;
        if (apiAuth !== 'pass')
            failing.push('api_auth');
    }
    // Worker roles (`live-worker`, `job-worker`): a worker_instances row exists.
    if (requirements.requiresWorkerRegistration) {
        const workerRegistered = deps.workerRegistered?.()
            ? 'pass'
            : 'fail';
        checks.worker_registered = workerRegistered;
        if (workerRegistered !== 'pass')
            failing.push('worker_registered');
    }
    // Role `job-worker`: the scheduler engine is claiming jobs.
    if (requirements.requiresSchedulerClaiming) {
        const scheduler = deps.schedulerReady?.() ? 'pass' : 'fail';
        checks.scheduler = scheduler;
        if (scheduler !== 'pass')
            failing.push('scheduler');
    }
    // Role `live-worker`: report capacity (never failing). A saturated worker is
    // still ready — it routes continuations to active turns while the DB is up.
    if (requirements.requiresLiveCapacitySignal) {
        checks.live_capacity = await evaluateLiveCapacity(deps);
    }
    return {
        ready: failing.length === 0,
        role: deps.role,
        checks,
        failing,
    };
}
/**
 * 'available' when THIS worker can accept ≥1 new live turn (its own active live
 * turn count < its limit), 'saturated' otherwise. Fails closed to 'saturated'
 * when the DB is unreachable or the worker id/limit is unknown — a worker that
 * cannot prove free capacity should not advertise it.
 */
async function evaluateLiveCapacity(deps) {
    const workerInstanceId = deps.currentWorkerInstanceId?.() ?? null;
    const limit = deps.liveCapacityLimit?.() ?? 0;
    if (!workerInstanceId || limit <= 0)
        return 'saturated';
    try {
        const rows = await deps.query(`SELECT count(*)::int AS active
       FROM live_turns
       WHERE worker_instance_id = ${quoteSqlLiteral(workerInstanceId)}
         AND state NOT IN ('completed', 'failed', 'timed_out')`);
        const active = rows[0]?.active ?? 0;
        return active < limit ? 'available' : 'saturated';
    }
    catch {
        return 'saturated';
    }
}
/** Single-quote a SQL string literal for the parameterless query interface. */
function quoteSqlLiteral(value) {
    return `'${value.replace(/'/g, "''")}'`;
}
/**
 * Starvation threshold for the `gantry_capability_starved_runs` gauge, in
 * seconds. Kept as a code constant (no settings key) and aligned with the
 * scheduler starvation scan's 5-minute default.
 */
const CAPABILITY_STARVATION_AGE_SECONDS = 5 * 60;
/**
 * Render Prometheus text-format metrics by hand (no client dependency). Every
 * database-derived gauge is guarded so `/metrics` never errors when the DB is
 * down — it always exports `gantry_up`, uptime, and the draining flag.
 */
export async function renderMetrics(deps) {
    const lines = [];
    const gauge = (name, help, value, labels) => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} gauge`);
        lines.push(`${name}${renderLabels(labels)} ${value}`);
    };
    gauge('gantry_up', 'Whether the process is serving requests.', 1);
    gauge('gantry_uptime_seconds', 'Process uptime in seconds.', Math.floor(deps.uptimeSeconds()));
    gauge('gantry_draining', 'Whether the process is draining (1) or serving normally (0).', deps.isDraining() ? 1 : 0);
    // Info-style gauge: the value is always 1; the role lives in the label.
    gauge('gantry_process_role', 'Process role of this runtime (info gauge).', 1, {
        role: deps.role,
    });
    lines.push('# HELP gantry_errors_total Operational errors caught at load-bearing runtime boundaries.');
    lines.push('# TYPE gantry_errors_total counter');
    for (const counter of snapshotOperationalErrors()) {
        lines.push(`gantry_errors_total${renderLabels({ subsystem: counter.subsystem, kind: counter.kind })} ${counter.count}`);
    }
    try {
        const rows = await deps.query(`SELECT status, count(*)::int AS count
       FROM worker_instances
       WHERE heartbeat_at > now() - interval '60 seconds'
       GROUP BY status`);
        lines.push('# HELP gantry_worker_instances Healthy worker instances by status (heartbeat within 60s).');
        lines.push('# TYPE gantry_worker_instances gauge');
        for (const row of rows) {
            lines.push(`gantry_worker_instances${renderLabels({ status: row.status })} ${row.count}`);
        }
    }
    catch {
        // Worker inventory unavailable; skip this gauge.
    }
    try {
        const rows = await deps.query(`SELECT state, count(*)::int AS count
       FROM pgboss.job
       WHERE state IN ('created', 'retry', 'active')
       GROUP BY state`);
        lines.push('# HELP gantry_queue_jobs pg-boss jobs by non-terminal state.');
        lines.push('# TYPE gantry_queue_jobs gauge');
        for (const row of rows) {
            lines.push(`gantry_queue_jobs${renderLabels({ state: row.state })} ${row.count}`);
        }
    }
    catch {
        // Queue depth unavailable; skip this gauge.
    }
    try {
        const rows = await deps.query(`SELECT status, count(*)::int AS count
       FROM runtime_dependencies
       GROUP BY status`);
        lines.push('# HELP gantry_bake_jobs Toolchain bake jobs by runtime_dependencies status.');
        lines.push('# TYPE gantry_bake_jobs gauge');
        for (const row of rows) {
            lines.push(`gantry_bake_jobs${renderLabels({ status: row.status })} ${row.count}`);
        }
    }
    catch {
        // Bake state unavailable; skip this gauge.
    }
    try {
        // Capability-starved runs: active jobs overdue past the starvation
        // threshold whose resolved required capability set is non-empty. The set is
        // persisted on the job target by capability-matched dispatch (fleet only);
        // workstation jobs never carry one, so this reads 0 there. Cheap and
        // guarded like the gauges above — a single aggregate over jobs.
        const rows = await deps.query(`SELECT
         count(*)::int AS starved,
         coalesce(
           max(extract(epoch FROM (now() - next_run_at))),
           0
         )::int AS max_age_seconds
       FROM jobs
       WHERE status = 'active'
         AND next_run_at IS NOT NULL
         AND next_run_at < now() - interval '${CAPABILITY_STARVATION_AGE_SECONDS} seconds'
         AND jsonb_array_length(
           coalesce(target_json -> 'requiredCapabilities', '[]'::jsonb)
         ) > 0`);
        const starved = rows[0]?.starved ?? 0;
        const maxAge = starved > 0 ? (rows[0]?.max_age_seconds ?? 0) : 0;
        gauge('gantry_capability_starved_runs', 'Active due jobs with a non-empty required capability set overdue past the starvation threshold.', starved);
        gauge('gantry_capability_starvation_age_seconds_max', 'Age in seconds of the oldest capability-starved due job (0 when none).', maxAge);
    }
    catch {
        // Starvation state unavailable; skip these gauges.
    }
    // Live execution gauges: only meaningful on a process that runs live turns.
    // A control/job-worker has nothing to report here, so they are skipped.
    if (deps.liveExecutionEnabled) {
        const workerInstanceId = deps.currentWorkerInstanceId();
        if (workerInstanceId) {
            try {
                // Non-terminal live turns owned by THIS worker.
                const rows = await deps.query(`SELECT count(*)::int AS count
           FROM live_turns
           WHERE worker_instance_id = ${quoteSqlLiteral(workerInstanceId)}
             AND state NOT IN ('completed', 'failed', 'timed_out')`);
                gauge('gantry_live_turns_active', 'Non-terminal live turns owned by this worker.', rows[0]?.count ?? 0);
            }
            catch {
                // Live-turn inventory unavailable; skip this gauge.
            }
        }
        try {
            const liveCapacityPlan = computeHostCapacityPlan({
                queue: {
                    maxMessageRuns: deps.liveCapacityLimit(),
                    maxJobRuns: deps.jobCapacityLimit(),
                },
                processRole: deps.role,
                cpuThreads: deps.hostCpuThreads?.(),
            });
            const limit = liveCapacityPlan.interactiveCapacity;
            const localCapacity = workerInstanceId ? limit : 0;
            const localInteractiveSlotKey = hostExecutionSlotKey(workerInstanceId ?? undefined, 'interactive');
            const localRows = await deps.query(`SELECT count(*)::int AS count
         FROM run_slots
         WHERE slot_key = ${quoteSqlLiteral(localInteractiveSlotKey)}
           AND expires_at > now()`);
            // Cluster-wide live slot usage: unexpired run_slots whose key is a live
            // per-worker slot key. The LIKE pattern matches `live:messages:<id>`.
            const rows = await deps.query(`SELECT count(*)::int AS count
         FROM run_slots
         WHERE slot_key LIKE ${quoteSqlLiteral(`${LIVE_TURN_SLOT_KEY_PREFIX}%`)}
           AND expires_at > now()`);
            gauge('gantry_live_slots_used_cluster', 'Unexpired live-turn run slots held cluster-wide.', rows[0]?.count ?? 0);
            gauge('gantry_live_slots_used_local', 'Unexpired host execution slots held by interactive work on this runtime host.', localRows[0]?.count ?? 0);
            gauge('gantry_live_slots_capacity_local', 'Effective host-clamped live-turn capacity on this runtime host.', localCapacity);
            gauge('gantry_live_warm_spare', 'Whether this runtime host has at least one free live-turn slot.', localCapacity > (localRows[0]?.count ?? 0) ? 1 : 0);
        }
        catch {
            // Slot usage unavailable; skip this gauge.
        }
        try {
            // Recoverable live turns: the cheap COUNT form of the recovery sweep's
            // listRecoverableLiveTurns predicate — non-terminal turns whose run lease
            // is gone (owner lost). Unleased-but-stale turns are time-windowed in the
            // sweep; here we report only the owner-lost class as a single statement.
            const rows = await deps.query(`SELECT count(*)::int AS count
         FROM live_turns lt
         WHERE lt.state NOT IN ('completed', 'failed', 'timed_out')
           AND lt.run_id IS NOT NULL
           AND lt.lease_token IS NOT NULL
           AND lt.fencing_version IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM run_leases rl
             WHERE rl.run_id = lt.run_id
               AND rl.status = 'active'
               AND rl.expires_at > now()
           )`);
            gauge('gantry_live_turns_recoverable', 'Non-terminal live turns whose owner lease has been lost (recoverable).', rows[0]?.count ?? 0);
        }
        catch {
            // Recoverable count unavailable; skip this gauge.
        }
        // Oldest waiting live admission age. Computed in-process (not a DB query),
        // so it is always emitted on a live process — 0 when nothing is waiting.
        gauge('gantry_live_oldest_waiting_seconds', 'Age in seconds of the oldest live message waiting to start (0 when none).', Math.max(0, Math.floor(deps.oldestWaitingLiveAdmissionSeconds())));
        try {
            const rows = await deps.query(`SELECT
           count(*)::int AS count,
           coalesce(max(extract(epoch FROM (now() - created_at))), 0)::int
             AS oldest_age_seconds
         FROM live_admission_work_items
         WHERE state = 'queued'
            OR (
              state = 'deferred'
              AND (defer_until IS NULL OR defer_until <= now())
            )`);
            gauge('gantry_live_admission_backlog', 'Queued live admission work items waiting to start.', rows[0]?.count ?? 0);
            gauge('gantry_live_admission_backlog_oldest_seconds', 'Age in seconds of the oldest queued live admission work item.', rows[0]?.oldest_age_seconds ?? 0);
        }
        catch {
            // Backlog unavailable; skip these gauges.
        }
    }
    try {
        const rows = await deps.query(`SELECT slot_key, count(*)::int AS count
       FROM run_slots
       WHERE slot_key NOT LIKE ${quoteSqlLiteral(`${LIVE_TURN_SLOT_KEY_PREFIX}%`)}
         AND slot_key NOT LIKE ${quoteSqlLiteral(`${HOST_EXECUTION_SLOT_KEY_PREFIX}%`)}
         AND expires_at > now()
       GROUP BY slot_key
       ORDER BY slot_key`);
        lines.push('# HELP gantry_background_job_slots_used Unexpired workspace run slots held by background jobs per slot key.');
        lines.push('# TYPE gantry_background_job_slots_used gauge');
        for (const row of rows) {
            lines.push(`gantry_background_job_slots_used${renderLabels({ slot_key: row.slot_key })} ${row.count}`);
        }
        gauge('gantry_background_job_slots_capacity', 'Effective host-clamped background job capacity.', computeHostCapacityPlan({
            queue: {
                maxMessageRuns: deps.liveCapacityLimit(),
                maxJobRuns: deps.jobCapacityLimit(),
            },
            processRole: deps.role,
            cpuThreads: deps.hostCpuThreads?.(),
        }).backgroundCapacity);
    }
    catch {
        // Background slot usage unavailable; skip these gauges.
    }
    return `${lines.join('\n')}\n`;
}
function renderLabels(labels) {
    if (!labels)
        return '';
    const entries = Object.entries(labels);
    if (entries.length === 0)
        return '';
    const rendered = entries
        .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
        .join(',');
    return `{${rendered}}`;
}
function escapeLabelValue(value) {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');
}
