const DEFAULT_PGBOSS_SCHEMA = 'pgboss';
const POSTGRES_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function resolvePgBossSchema(
  value = process.env.PGBOSS_SCHEMA,
): string {
  const schema = value?.trim() || DEFAULT_PGBOSS_SCHEMA;
  if (!POSTGRES_SCHEMA_PATTERN.test(schema)) {
    throw new Error(
      'PGBOSS_SCHEMA must be a lowercase PostgreSQL schema identifier',
    );
  }
  return schema;
}

export const PGBOSS_SCHEMA = resolvePgBossSchema();
