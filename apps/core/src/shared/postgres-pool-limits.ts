const DEFAULT_RUNTIME_POSTGRES_POOL_MAX = 20;
const PGBOSS_POOL_SHARE_DIVISOR = 4;

export function resolveRuntimePostgresPoolMax(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.GANTRY_POSTGRES_POOL_MAX?.trim();
  if (!raw) return DEFAULT_RUNTIME_POSTGRES_POOL_MAX;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('GANTRY_POSTGRES_POOL_MAX must be a positive integer.');
  }
  return parsed;
}

export function resolvePgBossPostgresPoolMax(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.GANTRY_PGBOSS_POOL_MAX?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error('GANTRY_PGBOSS_POOL_MAX must be a positive integer.');
    }
    return parsed;
  }
  return Math.max(
    1,
    Math.floor(resolveRuntimePostgresPoolMax(env) / PGBOSS_POOL_SHARE_DIVISOR),
  );
}
