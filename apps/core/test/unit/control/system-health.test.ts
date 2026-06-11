import { describe, expect, it, vi } from 'vitest';

import {
  evaluateReadiness,
  renderMetrics,
  type ReadinessDeps,
  type MetricsDeps,
} from '@core/control/server/system-health.js';

function makeReadinessDeps(
  overrides: Partial<ReadinessDeps> = {},
): ReadinessDeps {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('__drizzle_migrations')) {
        return [{ applied: 76 }] as never[];
      }
      return [{ '?column?': 1 }] as never[];
    }),
    shippedMigrationCount: () => 76,
    settingsLoaded: () => true,
    isDraining: () => false,
    ...overrides,
  };
}

describe('evaluateReadiness', () => {
  it('is green when all checks pass', async () => {
    const result = await evaluateReadiness(makeReadinessDeps());
    expect(result.ready).toBe(true);
    expect(result.checks).toEqual({
      database: 'pass',
      migrations: 'pass',
      settings: 'pass',
      draining: false,
    });
    expect(result.failing).toEqual([]);
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
      return [] as never[];
    }),
    isDraining: () => false,
    uptimeSeconds: () => 123.7,
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
