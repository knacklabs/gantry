/**
 * Operational health and metrics evaluation for the unversioned `/healthz`,
 * `/readyz`, and `/metrics` endpoints. These are internal-only endpoints
 * consumed by the load balancer (liveness/readiness) and Prometheus (metrics);
 * ALB rules own external exposure. The logic here is dependency-injected so it
 * can be unit-tested without a live database or HTTP server.
 */

export type CheckStatus = 'pass' | 'fail';

export interface ReadinessDeps {
  /** Runs a parameterless query; throws when the database is unreachable. */
  query: <T>(sql: string) => Promise<T[]>;
  /** Number of migrations shipped in this build (drizzle journal entries). */
  shippedMigrationCount: () => number;
  /** Whether runtime settings have been loaded into the process. */
  settingsLoaded: () => boolean;
  /** Whether the process has entered graceful-drain state. */
  isDraining: () => boolean;
}

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: CheckStatus;
    migrations: CheckStatus;
    settings: CheckStatus;
    draining: boolean;
  };
  failing: string[];
}

export async function evaluateReadiness(
  deps: ReadinessDeps,
): Promise<ReadinessResult> {
  const draining = deps.isDraining();

  let database: CheckStatus = 'fail';
  let migrations: CheckStatus = 'fail';
  try {
    await deps.query('SELECT 1');
    database = 'pass';
    const rows = await deps.query<{ applied: number }>(
      'SELECT count(*)::int AS applied FROM __drizzle_migrations',
    );
    const applied = rows[0]?.applied ?? 0;
    migrations = applied >= deps.shippedMigrationCount() ? 'pass' : 'fail';
  } catch {
    // Connection-level failure or missing migrations table: both DB and
    // migration checks fail, which is the correct not-ready signal.
  }

  const settings: CheckStatus = deps.settingsLoaded() ? 'pass' : 'fail';

  const failing: string[] = [];
  if (database !== 'pass') failing.push('database');
  if (migrations !== 'pass') failing.push('migrations');
  if (settings !== 'pass') failing.push('settings');
  if (draining) failing.push('draining');

  return {
    ready: failing.length === 0,
    checks: { database, migrations, settings, draining },
    failing,
  };
}

export interface MetricsDeps {
  query: <T>(sql: string) => Promise<T[]>;
  isDraining: () => boolean;
  uptimeSeconds: () => number;
}

interface WorkerStatusRow {
  status: string;
  count: number;
}

interface QueueDepthRow {
  state: string;
  count: number;
}

/**
 * Render Prometheus text-format metrics by hand (no client dependency). Every
 * database-derived gauge is guarded so `/metrics` never errors when the DB is
 * down — it always exports `gantry_up`, uptime, and the draining flag.
 */
export async function renderMetrics(deps: MetricsDeps): Promise<string> {
  const lines: string[] = [];
  const gauge = (
    name: string,
    help: string,
    value: number,
    labels?: Record<string, string>,
  ): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name}${renderLabels(labels)} ${value}`);
  };

  gauge('gantry_up', 'Whether the process is serving requests.', 1);
  gauge(
    'gantry_uptime_seconds',
    'Process uptime in seconds.',
    Math.floor(deps.uptimeSeconds()),
  );
  gauge(
    'gantry_draining',
    'Whether the process is draining (1) or serving normally (0).',
    deps.isDraining() ? 1 : 0,
  );

  try {
    const rows = await deps.query<WorkerStatusRow>(
      `SELECT status, count(*)::int AS count
       FROM worker_instances
       WHERE heartbeat_at > now() - interval '60 seconds'
       GROUP BY status`,
    );
    lines.push(
      '# HELP gantry_worker_instances Healthy worker instances by status (heartbeat within 60s).',
    );
    lines.push('# TYPE gantry_worker_instances gauge');
    for (const row of rows) {
      lines.push(
        `gantry_worker_instances${renderLabels({ status: row.status })} ${row.count}`,
      );
    }
  } catch {
    // Worker inventory unavailable; skip this gauge.
  }

  try {
    const rows = await deps.query<QueueDepthRow>(
      `SELECT state, count(*)::int AS count
       FROM pgboss.job
       WHERE state IN ('created', 'retry', 'active')
       GROUP BY state`,
    );
    lines.push('# HELP gantry_queue_jobs pg-boss jobs by non-terminal state.');
    lines.push('# TYPE gantry_queue_jobs gauge');
    for (const row of rows) {
      lines.push(
        `gantry_queue_jobs${renderLabels({ state: row.state })} ${row.count}`,
      );
    }
  } catch {
    // Queue depth unavailable; skip this gauge.
  }

  return `${lines.join('\n')}\n`;
}

function renderLabels(labels?: Record<string, string>): string {
  if (!labels) return '';
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(',');
  return `{${rendered}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}
