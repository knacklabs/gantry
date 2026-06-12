/**
 * Standalone worker process for the two-process claim e2e. Spawned as a SEPARATE
 * OS process (via tsx) by claim-protocol-two-process.e2e.test.ts. It connects to
 * the shared disposable Postgres at a fixed schema, then competes for a single
 * scheduled run through the REAL scheduler claim protocol:
 *
 *   claimDueJobRunStart (creates the run row + run_leases lease token + monotonic
 *     fencing version, atomically refusing a run that is already claimed OR
 *     already terminal)
 *     → on win: finalizeJobRunWithLease (lease-fenced terminal run + lease settle
 *       in one step)
 *
 * Using claimDueJobRunStart (the production scheduler entrypoint) rather than the
 * lower-level claimRunLease is what makes the race deterministic regardless of
 * process timing: the loser is refused whether it arrives while the winner's
 * lease is still active (claimed-elsewhere) or after the winner already finished
 * (terminal run row). It is not an in-process fake — each invocation is its own
 * Node process with its own pg Pool.
 *
 * It prints exactly one JSON line to stdout describing its outcome and exits 0.
 * No channel credentials are required — only the storage URL and schema.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, '../../../src');

async function main(): Promise<void> {
  const databaseUrl = requireEnv('GANTRY_TEST_DATABASE_URL');
  const schema = requireEnv('CHAOS_SCHEMA');
  const runId = requireEnv('CHAOS_RUN_ID');
  const jobId = requireEnv('CHAOS_JOB_ID');
  const workerInstanceId = requireEnv('CHAOS_WORKER_INSTANCE_ID');
  // Optional barrier: spin until this wall-clock ms so both processes race the
  // claim at the same moment (set by the parent to a near-future timestamp).
  const startAtMs = Number(process.env.CHAOS_START_AT_MS ?? '0');

  const { PostgresStorageService } = await import(
    pathTo('adapters/storage/postgres/storage-service.js')
  );
  const { createPostgresDomainRepositories } = await import(
    pathTo(
      'adapters/storage/postgres/repositories/domain-repositories.postgres.js',
    )
  );
  const { PostgresRuntimeRepositoryBundle } = await import(
    pathTo('adapters/storage/postgres/schema/canonical-ops-repo.postgres.js')
  );
  const { RuntimeEventExchange } = await import(
    pathTo('application/runtime-events/runtime-event-exchange.js')
  );
  const { PostgresRuntimeEventNotifier } = await import(
    pathTo('adapters/storage/postgres/runtime-event-notifier.postgres.js')
  );

  // Reuse the existing schema (the parent already migrated it). Do NOT migrate
  // here: two concurrent migrators are serialized by an advisory lock anyway,
  // but the parent owns schema lifecycle in this e2e.
  const service = new PostgresStorageService(databaseUrl, schema);
  const repositories = createPostgresDomainRepositories(
    service.db,
    service.pool,
  );
  const runtimeEventNotifier = new PostgresRuntimeEventNotifier(service.pool);
  const runtimeEvents = new RuntimeEventExchange(
    repositories.runtimeEvents,
    runtimeEventNotifier,
  );
  const ops = new PostgresRuntimeRepositoryBundle(service.pool, service.db, {
    runtimeEvents,
  });

  try {
    if (startAtMs > 0) {
      while (Date.now() < startAtMs) {
        // Tight spin to the shared barrier; the window is a few hundred ms.
      }
    }

    const nowIso = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const lease = await ops.claimDueJobRunStart({
      jobId,
      runId,
      executionProviderId: 'anthropic:claude-agent-sdk' as never,
      workerInstanceId,
      workerId: workerInstanceId,
      scheduledFor: nowIso,
      startedAt: nowIso,
      retryCount: 0,
      leaseExpiresAt,
      requireNextRun: false,
    });

    if (!lease) {
      emit({ workerInstanceId, claimed: false });
      return;
    }

    // Lease-fenced terminal write + lease settle in one step, then mark the job
    // active again — the exact production finalize path.
    const finalized = await ops.finalizeJobRunWithLease!({
      jobId,
      runId,
      leaseToken: lease.leaseToken,
      workerInstanceId: lease.workerInstanceId,
      fencingVersion: lease.fencingVersion,
      leaseOutcome: 'completed',
      runStatus: 'completed',
      resultSummary: `completed by ${workerInstanceId}`,
      jobUpdates: {
        status: 'active',
        next_run: null,
        last_run: nowIso,
        consecutive_failures: 0,
        pause_reason: null,
        lease_run_id: null,
        lease_expires_at: null,
      },
    });

    emit({
      workerInstanceId,
      claimed: true,
      fencingVersion: lease.fencingVersion,
      completed: finalized,
    });
  } finally {
    await service.close();
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    emit({ error: `${name} is required` });
    process.exit(2);
  }
  return value;
}

function pathTo(relative: string): string {
  return path.join(srcDir, relative);
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ ...payload, marker: 'CHAOS_WORKER' })}\n`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    emit({ error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  },
);
