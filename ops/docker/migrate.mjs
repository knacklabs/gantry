// Race-safe migration runner for the Gantry container entrypoint.
//
// Wraps the SAME migration path the runtime uses on boot
// (PostgresStorageService.migrate at
//  dist/adapters/storage/postgres/storage-service.js), under a session-scoped
// Postgres advisory lock so that concurrent boots in a rolling deploy serialize
// migration instead of racing the drizzle migrator.
//
// Why this is safe for N workers that all run it:
//   - The advisory lock (pg_advisory_lock) serializes the migrate step across
//     every instance: the holder migrates; others block until it disconnects.
//   - migrate() is idempotent — drizzle records applied migrations in
//     __drizzle_migrations and only applies pending ones; pg-boss migrate is
//     idempotent; pgcrypto install is guarded by its own advisory lock.
//   - The lock is a SESSION lock; it is released automatically when this process
//     disconnects, even on crash, so a dead migrator cannot wedge the fleet.
//   - Because the entrypoint completes migration before exec-ing the runtime,
//     the runtime's own boot-time migrate() finds nothing pending and is a fast
//     no-op against the already-migrated schema.
//
// Connection URL precedence (migration role may differ from the runtime role):
//   MIGRATION_DATABASE_URL  ->  GANTRY_DATABASE_URL
// Schema precedence:
//   GANTRY_DB_SCHEMA  ->  "gantry" (matches DEFAULT_STORAGE_POSTGRES_SCHEMA)

import { Client } from 'pg';

import { PostgresStorageService } from '../../dist/adapters/storage/postgres/storage-service.js';

// Stable, arbitrary 64-bit advisory lock identity for "run gantry migrations".
// Two 32-bit keys -> pg_advisory_lock(int, int). Distinct from the pgcrypto
// extension lock (1340193180,1) used inside migrate().
const MIGRATION_LOCK_NAMESPACE = 1340193180;
const MIGRATION_LOCK_KEY = 2;

function resolveMigrationUrl() {
  const url =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.GANTRY_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'No database URL: set MIGRATION_DATABASE_URL or GANTRY_DATABASE_URL.',
    );
  }
  return url;
}

function resolveSchema() {
  return process.env.GANTRY_DB_SCHEMA?.trim() || 'gantry';
}

// Mirror the runtime's SSL posture: remote hosts require TLS, local does not.
function isLocalHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function lockClientConfig(url) {
  const parsed = new URL(url);
  const local = isLocalHost(parsed.hostname);
  return {
    connectionString: url,
    ...(local ? {} : { ssl: { rejectUnauthorized: true } }),
  };
}

async function main() {
  const url = resolveMigrationUrl();
  const schema = resolveSchema();

  // Dedicated lock connection so the session lock lifetime is the migration's.
  const lockClient = new Client(lockClientConfig(url));
  await lockClient.connect();

  let migrationError;
  try {
    await lockClient.query('SELECT pg_advisory_lock($1, $2)', [
      MIGRATION_LOCK_NAMESPACE,
      MIGRATION_LOCK_KEY,
    ]);

    const service = new PostgresStorageService(url, schema);
    try {
      await service.migrate();
    } finally {
      await service.close();
    }
  } catch (err) {
    migrationError = err;
  } finally {
    // Best-effort explicit unlock; disconnect releases the session lock anyway.
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_KEY,
      ]);
    } catch {
      // Ignore: closing the connection releases the lock.
    }
    await lockClient.end();
  }

  if (migrationError) {
    throw migrationError;
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gantry migrate failed: ${message}\n`);
  process.exit(1);
});
