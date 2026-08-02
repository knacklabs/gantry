/**
 * Operational health and metrics evaluation for the unversioned `/healthz`,
 * `/readyz`, and `/metrics` endpoints. These are internal-only endpoints
 * consumed by the load balancer (liveness/readiness) and Prometheus (metrics);
 * ALB rules own external exposure. The logic here is dependency-injected so it
 * can be unit-tested without a live database or HTTP server.
 */
/**
 * Process role string. Kept as a local union (not imported from the runtime
 * `roles` module) so this DI'd adapter-layer logic stays free of a cross-layer
 * import; the canonical union lives in app/bootstrap/roles/process-role.ts and
 * the caller passes the value plus the per-role check requirements.
 */
export type ProcessRole = 'all' | 'control' | 'live-worker' | 'job-worker';
/**
 * Which role-specific readiness checks apply, derived by the caller from the
 * role (app/bootstrap/roles/role-readiness.ts). The workstation `all` role
 * passes all-false so its check set stays exactly the historical one.
 */
export interface ReadinessRoleRequirements {
    requiresApiAuthConfigured: boolean;
    requiresWorkerRegistration: boolean;
    requiresSchedulerClaiming: boolean;
    requiresLiveCapacitySignal: boolean;
}
export type CheckStatus = 'pass' | 'fail';
/** Reported (never failing) live-worker capacity state. */
export type LiveCapacity = 'available' | 'saturated';
export interface ReadinessDeps {
    /** Process role this server runs as; surfaced as the top-level `role`. */
    role: ProcessRole;
    /** Which role-specific checks apply (the caller derives this from `role`). */
    requirements: ReadinessRoleRequirements;
    /** Runs a parameterless query; throws when the database is unreachable. */
    query: <T>(sql: string) => Promise<T[]>;
    /** Number of migrations shipped in this build (drizzle journal entries). */
    shippedMigrationCount: () => number;
    /** Whether runtime settings have been loaded into the process. */
    settingsLoaded: () => boolean;
    /** Whether the process has entered graceful-drain state. */
    isDraining: () => boolean;
    /**
     * Count of valid control API keys parsed at startup. Drives the `api_auth`
     * check for the `control` role. Required when the role needs API auth.
     */
    apiKeyCount?: () => number;
    /**
     * Whether this worker registered a `worker_instances` row. Drives the
     * `worker_registered` check for worker roles. Required when the role
     * requires worker registration.
     */
    workerRegistered?: () => boolean;
    /**
     * Whether the scheduler engine is ready. Drives the `scheduler` check for
     * the `job-worker` role. Required when the role claims scheduled jobs.
     */
    schedulerReady?: () => boolean;
    /**
     * This worker's max concurrent live turns (`runtime.queue.max_message_runs`).
     * Used with the active-turn count to derive `live_capacity`. Required when
     * the role advertises live capacity.
     */
    liveCapacityLimit?: () => number;
    /** This worker's instance id, or null before registration. */
    currentWorkerInstanceId?: () => string | null;
}
export interface ReadinessResult {
    ready: boolean;
    role: ProcessRole;
    checks: {
        database: CheckStatus;
        migrations: CheckStatus;
        settings: CheckStatus;
        draining: boolean;
        api_auth?: CheckStatus;
        worker_registered?: CheckStatus;
        scheduler?: CheckStatus;
        /** Reported, NEVER failing: a saturated worker still routes continuations. */
        live_capacity?: LiveCapacity;
    };
    failing: string[];
}
export declare function evaluateReadiness(deps: ReadinessDeps): Promise<ReadinessResult>;
export interface MetricsDeps {
    query: <T>(sql: string) => Promise<T[]>;
    isDraining: () => boolean;
    uptimeSeconds: () => number;
    /** Process role; emitted as the always-on `gantry_process_role` info gauge. */
    role: ProcessRole;
    /**
     * Whether this process runs live execution. Live gauges are only emitted when
     * true (a control/job-worker has no live capacity to report).
     */
    liveExecutionEnabled: boolean;
    /** This worker's instance id, or null before registration. */
    currentWorkerInstanceId: () => string | null;
    /** Per-live-worker live turn capacity from runtime.queue.max_message_runs. */
    liveCapacityLimit: () => number;
    /** Per-workspace background job capacity from runtime.queue.max_job_runs. */
    jobCapacityLimit: () => number;
    hostCpuThreads?: () => number;
    /**
     * Age in seconds of the oldest pending live admission waiting for a free
     * worker (0 when none). Reported by the runtime; computed cheaply in-process,
     * NOT via a DB query here, so it stays in the always-on (non DB-guarded) set.
     */
    oldestWaitingLiveAdmissionSeconds: () => number;
}
/**
 * Render Prometheus text-format metrics by hand (no client dependency). Every
 * database-derived gauge is guarded so `/metrics` never errors when the DB is
 * down — it always exports `gantry_up`, uptime, and the draining flag.
 */
export declare function renderMetrics(deps: MetricsDeps): Promise<string>;
