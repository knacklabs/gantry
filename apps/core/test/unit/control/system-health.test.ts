import { describe, expect, it, vi } from 'vitest';

import {
  evaluateReadiness,
  renderMetrics,
  type ReadinessDeps,
  type MetricsDeps,
} from '@core/control/server/system-health.js';

const ALL_REQUIREMENTS = {
  requiresApiAuthConfigured: false,
  requiresWorkerRegistration: false,
  requiresSchedulerClaiming: false,
  requiresLiveCapacitySignal: false,
} as const;

const REQUIREMENTS_BY_ROLE: Record<
  'all' | 'control' | 'live-worker' | 'job-worker',
  ReadinessDeps['requirements']
> = {
  all: ALL_REQUIREMENTS,
  control: { ...ALL_REQUIREMENTS, requiresApiAuthConfigured: true },
  'live-worker': {
    ...ALL_REQUIREMENTS,
    requiresWorkerRegistration: true,
    requiresLiveCapacitySignal: true,
  },
  'job-worker': {
    ...ALL_REQUIREMENTS,
    requiresWorkerRegistration: true,
    requiresSchedulerClaiming: true,
  },
};

function makeReadinessDeps(
  overrides: Partial<ReadinessDeps> = {},
): ReadinessDeps {
  const role = overrides.role ?? 'all';
  return {
    role,
    requirements: REQUIREMENTS_BY_ROLE[role],
    query: vi.fn(async (sql: string) => {
      if (sql.includes('__drizzle_migrations')) {
        return [{ applied: 76 }] as never[];
      }
      if (sql.includes('live_turns')) {
        return [{ active: 0 }] as never[];
      }
      return [{ '?column?': 1 }] as never[];
    }),
    shippedMigrationCount: () => 76,
    settingsLoaded: () => true,
    isDraining: () => false,
    apiKeyCount: () => 1,
    workerRegistered: () => true,
    schedulerReady: () => true,
    liveCapacityLimit: () => 3,
    currentWorkerInstanceId: () => 'worker-1',
    ...overrides,
  };
}

describe('evaluateReadiness', () => {
  it('is green when all checks pass', async () => {
    const result = await evaluateReadiness(makeReadinessDeps());
    expect(result.ready).toBe(true);
    expect(result.role).toBe('all');
    expect(result.checks).toEqual({
      database: 'pass',
      migrations: 'pass',
      settings: 'pass',
      draining: false,
    });
    expect(result.failing).toEqual([]);
  });

  it('role all keeps the historical checks (no role-specific checks)', async () => {
    const result = await evaluateReadiness(makeReadinessDeps({ role: 'all' }));
    expect(result.checks).not.toHaveProperty('api_auth');
    expect(result.checks).not.toHaveProperty('worker_registered');
    expect(result.checks).not.toHaveProperty('scheduler');
    expect(result.checks).not.toHaveProperty('live_capacity');
  });

  it('role control adds api_auth (pass when ≥1 key)', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ role: 'control', apiKeyCount: () => 2 }),
    );
    expect(result.role).toBe('control');
    expect(result.checks.api_auth).toBe('pass');
    expect(result.checks).not.toHaveProperty('worker_registered');
    expect(result.ready).toBe(true);
  });

  it('role control fails api_auth and is not ready when no keys configured', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ role: 'control', apiKeyCount: () => 0 }),
    );
    expect(result.checks.api_auth).toBe('fail');
    expect(result.failing).toContain('api_auth');
    expect(result.ready).toBe(false);
  });

  it('role live-worker adds worker_registered + live_capacity field', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ role: 'live-worker' }),
    );
    expect(result.checks.worker_registered).toBe('pass');
    expect(result.checks.live_capacity).toBe('available');
    expect(result.checks).not.toHaveProperty('scheduler');
    expect(result.ready).toBe(true);
  });

  it('live-worker fails worker_registered when no worker id', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({
        role: 'live-worker',
        workerRegistered: () => false,
        currentWorkerInstanceId: () => null,
      }),
    );
    expect(result.checks.worker_registered).toBe('fail');
    expect(result.failing).toContain('worker_registered');
    expect(result.ready).toBe(false);
  });

  it('live_capacity reports saturated but NEVER fails readiness', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({
        role: 'live-worker',
        query: vi.fn(async (sql: string) => {
          if (sql.includes('__drizzle_migrations')) {
            return [{ applied: 76 }] as never[];
          }
          if (sql.includes('live_turns')) {
            return [{ active: 3 }] as never[];
          }
          return [{ '?column?': 1 }] as never[];
        }),
        liveCapacityLimit: () => 3,
      }),
    );
    expect(result.checks.live_capacity).toBe('saturated');
    expect(result.failing).not.toContain('live_capacity');
    expect(result.ready).toBe(true);
  });

  it('role job-worker adds worker_registered + scheduler checks', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ role: 'job-worker' }),
    );
    expect(result.checks.worker_registered).toBe('pass');
    expect(result.checks.scheduler).toBe('pass');
    expect(result.checks).not.toHaveProperty('live_capacity');
    expect(result.ready).toBe(true);
  });

  it('job-worker fails scheduler check when scheduler not ready', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ role: 'job-worker', schedulerReady: () => false }),
    );
    expect(result.checks.scheduler).toBe('fail');
    expect(result.failing).toContain('scheduler');
    expect(result.ready).toBe(false);
  });

  it('is red and names the database check when the database is down', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({
        query: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe('fail');
    expect(result.checks.migrations).toBe('fail');
    expect(result.failing).toContain('database');
    expect(result.failing).toContain('migrations');
  });

  it('is red and names migrations when applied count is behind the build', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('__drizzle_migrations')) {
            return [{ applied: 70 }] as never[];
          }
          return [{ '?column?': 1 }] as never[];
        }),
        shippedMigrationCount: () => 76,
      }),
    );
    expect(result.ready).toBe(false);
    expect(result.checks.database).toBe('pass');
    expect(result.checks.migrations).toBe('fail');
    expect(result.failing).toEqual(['migrations']);
  });

  it('is red and names settings when runtime settings are not loaded', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ settingsLoaded: () => false }),
    );
    expect(result.ready).toBe(false);
    expect(result.checks.settings).toBe('fail');
    expect(result.failing).toEqual(['settings']);
  });

  it('is red while draining even when every check passes (ALB pull during shutdown)', async () => {
    const result = await evaluateReadiness(
      makeReadinessDeps({ isDraining: () => true }),
    );
    expect(result.ready).toBe(false);
    expect(result.checks.draining).toBe(true);
    expect(result.failing).toEqual(['draining']);
  });
});

function makeMetricsDeps(overrides: Partial<MetricsDeps> = {}): MetricsDeps {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('worker_instances')) {
        if (!sql.includes('GROUP BY status')) {
          return [{ count: 2 }] as never[];
        }
        return [
          { status: 'healthy', count: 2 },
          { status: 'draining', count: 1 },
        ] as never[];
      }
      if (sql.includes('pgboss.job')) {
        return [
          { state: 'created', count: 5 },
          { state: 'active', count: 1 },
        ] as never[];
      }
      if (sql.includes('runtime_dependencies')) {
        return [
          { status: 'uploaded', count: 2 },
          { status: 'failed', count: 1 },
        ] as never[];
      }
      if (sql.includes('requiredCapabilities')) {
        return [{ starved: 3, max_age_seconds: 742 }] as never[];
      }
      // Live gauges: distinguish per-query so each gets its own count.
      if (sql.includes('run_slots') && sql.includes('NOT LIKE')) {
        return [{ slot_key: 'tg:team', count: 1 }] as never[];
      }
      if (sql.includes('run_slots')) return [{ count: 4 }] as never[];
      if (sql.includes('live_admission_work_items')) {
        return [{ count: 2, oldest_age_seconds: 33 }] as never[];
      }
      if (sql.includes('run_leases')) return [{ count: 1 }] as never[];
      if (sql.includes('live_turns')) return [{ count: 2 }] as never[];
      return [] as never[];
    }),
    isDraining: () => false,
    uptimeSeconds: () => 123.7,
    role: 'all',
    liveExecutionEnabled: true,
    currentWorkerInstanceId: () => 'worker-1',
    liveCapacityLimit: () => 3,
    jobCapacityLimit: () => 4,
    oldestWaitingLiveAdmissionSeconds: () => 0,
    ...overrides,
  };
}

describe('renderMetrics', () => {
  it('renders valid Prometheus text with process, worker, and queue gauges', async () => {
    const body = await renderMetrics(makeMetricsDeps());
    expect(body.endsWith('\n')).toBe(true);
    expect(body).toContain('# TYPE gantry_up gauge');
    expect(body).toContain('gantry_up 1');
    expect(body).toContain('gantry_uptime_seconds 123');
    expect(body).toContain('gantry_draining 0');
    expect(body).toContain('gantry_worker_instances{status="healthy"} 2');
    expect(body).toContain('gantry_worker_instances{status="draining"} 1');
    expect(body).toContain('gantry_queue_jobs{state="created"} 5');
    expect(body).toContain('gantry_queue_jobs{state="active"} 1');
  });

  it('always emits gantry_process_role with the role label', async () => {
    const body = await renderMetrics(makeMetricsDeps({ role: 'live-worker' }));
    expect(body).toContain('# TYPE gantry_process_role gauge');
    expect(body).toContain('gantry_process_role{role="live-worker"} 1');
  });

  it('emits live execution gauges when live execution is enabled', async () => {
    const body = await renderMetrics(
      makeMetricsDeps({
        role: 'live-worker',
        liveExecutionEnabled: true,
        oldestWaitingLiveAdmissionSeconds: () => 42,
      }),
    );
    expect(body).toContain('gantry_live_turns_active 2');
    expect(body).toContain('gantry_live_slots_used_cluster 4');
    expect(body).toContain('gantry_live_slots_capacity_cluster 6');
    expect(body).toContain('gantry_live_warm_spare 1');
    expect(body).toContain('gantry_live_turns_recoverable 1');
    expect(body).toContain('gantry_live_oldest_waiting_seconds 42');
    expect(body).toContain('gantry_live_admission_backlog 2');
    expect(body).toContain('gantry_live_admission_backlog_oldest_seconds 33');
    expect(body).toContain(
      'gantry_background_job_slots_used{slot_key="tg:team"} 1',
    );
    expect(body).toContain('gantry_background_job_slots_capacity 4');
    expect(body).not.toContain('available worker');
  });

  it('skips live execution gauges when live execution is disabled', async () => {
    const body = await renderMetrics(
      makeMetricsDeps({ role: 'job-worker', liveExecutionEnabled: false }),
    );
    expect(body).not.toContain('gantry_live_turns_active');
    expect(body).not.toContain('gantry_live_slots_used_cluster');
    expect(body).not.toContain('gantry_live_oldest_waiting_seconds');
    // The role info gauge is always present, even with no live gauges.
    expect(body).toContain('gantry_process_role{role="job-worker"} 1');
  });

  it('omits gantry_live_turns_active when the worker id is unknown', async () => {
    const body = await renderMetrics(
      makeMetricsDeps({
        role: 'live-worker',
        currentWorkerInstanceId: () => null,
      }),
    );
    expect(body).not.toContain('gantry_live_turns_active');
    // Cluster-wide gauges do not need a worker id and still emit.
    expect(body).toContain('gantry_live_slots_used_cluster 4');
  });

  it('renders bake-job and capability-starvation gauges', async () => {
    const body = await renderMetrics(makeMetricsDeps());
    expect(body).toContain('# TYPE gantry_bake_jobs gauge');
    expect(body).toContain('gantry_bake_jobs{status="uploaded"} 2');
    expect(body).toContain('gantry_bake_jobs{status="failed"} 1');
    expect(body).toContain('gantry_capability_starved_runs 3');
    expect(body).toContain('gantry_capability_starvation_age_seconds_max 742');
  });

  it('reports zero starvation age when no runs are starved', async () => {
    const body = await renderMetrics(
      makeMetricsDeps({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('requiredCapabilities')) {
            return [{ starved: 0, max_age_seconds: 999 }] as never[];
          }
          return [] as never[];
        }),
      }),
    );
    expect(body).toContain('gantry_capability_starved_runs 0');
    expect(body).toContain('gantry_capability_starvation_age_seconds_max 0');
  });

  it('exports gantry_draining=1 while draining', async () => {
    const body = await renderMetrics(
      makeMetricsDeps({ isDraining: () => true }),
    );
    expect(body).toContain('gantry_draining 1');
  });

  it('degrades gracefully when the database is down: still exports core gauges', async () => {
    const body = await renderMetrics(
      makeMetricsDeps({
        query: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      }),
    );
    expect(body).toContain('gantry_up 1');
    expect(body).toContain('gantry_uptime_seconds');
    expect(body).toContain('gantry_draining 0');
    expect(body).not.toContain('gantry_worker_instances{');
    expect(body).not.toContain('gantry_queue_jobs{');
    expect(body).not.toContain('gantry_bake_jobs{');
    expect(body).not.toContain('gantry_capability_starved_runs');
  });
});
