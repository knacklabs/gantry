// Race-safe migration runner for the Gantry container entrypoint.
//
// Runs the SAME migration path the runtime uses on non-container boot
// (PostgresStorageService.migrate at
//  dist/adapters/storage/postgres/storage-service.js).
//
// Serialization: migrate() itself takes a session-scoped Postgres advisory
// lock (RUNTIME_MIGRATION_LOCK_NAMESPACE/KEY in storage-service) around the
// drizzle migrator. Do NOT add an outer lock here: taking the same advisory lock
// on a second session before calling migrate() would self-deadlock against the
// lock inside migrate().
//
// Why this is safe for N workers that all run it:
//   - migrate() is idempotent — drizzle records applied migrations in
//     __drizzle_migrations and only applies pending ones; pg-boss migrate is
//     idempotent; pgcrypto install is guarded by its own advisory lock.
//   - The advisory lock is a SESSION lock; it is released automatically when
//     the holder disconnects, even on crash, so a dead migrator cannot wedge
//     the fleet.
//   - Because the entrypoint completes migration before exec-ing the runtime,
//     it sets GANTRY_SKIP_RUNTIME_MIGRATIONS=1 so the long-lived runtime only
//     health-checks the already-migrated schema.
//
// Connection URL precedence:
//   GANTRY_BOOTSTRAP_DATABASE_URL -> GANTRY_DATABASE_URL
// Schema precedence mirrors the ECS settings bootstrap:
//   GANTRY_SETTINGS_POSTGRES_SCHEMA
//   schema= query parameter in GANTRY_DATABASE_URL
//   schema= query parameter in GANTRY_BOOTSTRAP_DATABASE_URL
//   GANTRY_DB_SCHEMA
//   "gantry" (matches DEFAULT_STORAGE_POSTGRES_SCHEMA)

import { PostgresStorageService } from '../../dist/adapters/storage/postgres/storage-service.js';
import { fleetRehearsalPlaintextPostgresHosts } from '../../dist/adapters/storage/postgres/url.js';

function resolveDatabaseUrl() {
  const url =
    process.env.GANTRY_BOOTSTRAP_DATABASE_URL?.trim() ||
    process.env.GANTRY_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'No database URL: set GANTRY_DATABASE_URL or GANTRY_BOOTSTRAP_DATABASE_URL.',
    );
  }
  return url;
}

function resolveSchema() {
  const explicit = process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA?.trim();
  if (explicit) return explicit;

  const url = process.env.GANTRY_DATABASE_URL?.trim();
  if (url) {
    try {
      const schema = new URL(url).searchParams.get('schema')?.trim();
      if (schema) return schema;
    } catch {
      // Let PostgresStorageService report malformed URLs below.
    }
  }

  const bootstrapUrl = process.env.GANTRY_BOOTSTRAP_DATABASE_URL?.trim();
  if (bootstrapUrl) {
    try {
      const schema = new URL(bootstrapUrl).searchParams.get('schema')?.trim();
      if (schema) return schema;
    } catch {
      // Let PostgresStorageService report malformed URLs below.
    }
  }

  return process.env.GANTRY_DB_SCHEMA?.trim() || 'gantry';
}

async function main() {
  const url = resolveDatabaseUrl();
  const schema = resolveSchema();

  const service = new PostgresStorageService(url, schema, {
    plaintextHostAllowlist: fleetRehearsalPlaintextPostgresHosts(),
  });
  try {
    await service.migrate();
  } finally {
    await service.close();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gantry migrate failed: ${message}\n`);
  process.exit(1);
});
