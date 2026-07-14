const DEFAULT_PGBOSS_SCHEMA = 'pgboss';

export function runtimePgBossSchema(): string {
  const value =
    process.env.GANTRY_PGBOSS_SCHEMA?.trim() || DEFAULT_PGBOSS_SCHEMA;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid GANTRY_PGBOSS_SCHEMA: ${value}`);
  }
  return value;
}

export function runtimePgBossJobTableSql(): string {
  return `${quoteIdentifier(runtimePgBossSchema())}.job`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
