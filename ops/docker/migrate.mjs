// Race-safe migration runner for the Gantry container entrypoint.
//
// Runs the SAME migration path the runtime uses on boot
// (PostgresStorageService.migrate at
//  dist/adapters/storage/postgres/storage-service.js).
//
// Serialization: migrate() itself takes a session-scoped Postgres advisory
// lock (RUNTIME_MIGRATION_LOCK_NAMESPACE/KEY in storage-service) around the
// drizzle migrator. That single lock identity serializes EVERY migrator —
// entrypoint passes like this one AND runtime boot-time migrate() calls — so
// N instances booting at once are safe in any mix: the lock holder migrates,
// the rest block then find nothing pending. Do NOT add an outer lock here:
// taking the same advisory lock on a second session before calling migrate()
// would self-deadlock against the lock inside migrate().
//
// Why this is safe for N workers that all run it:
//   - migrate() is idempotent — drizzle records applied migrations in
//     __drizzle_migrations and only applies pending ones; pg-boss migrate is
//     idempotent; pgcrypto install is guarded by its own advisory lock.
//   - The advisory lock is a SESSION lock; it is released automatically when
//     the holder disconnects, even on crash, so a dead migrator cannot wedge
//     the fleet.
//   - Because the entrypoint completes migration before exec-ing the runtime,
//     the runtime's own boot-time migrate() finds nothing pending and is a
//     fast no-op against the already-migrated schema.
//
// Connection URL precedence (migration role may differ from the runtime role):
//   MIGRATION_DATABASE_URL  ->  GANTRY_DATABASE_URL
// Schema precedence:
//   GANTRY_DB_SCHEMA  ->  "gantry" (matches DEFAULT_STORAGE_POSTGRES_SCHEMA)

import { PostgresStorageService } from '../../dist/adapters/storage/postgres/storage-service.js';

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

async function main() {
  const url = resolveMigrationUrl();
  const schema = resolveSchema();

  const service = new PostgresStorageService(url, schema);
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
