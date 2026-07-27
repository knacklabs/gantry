import {
  createStorageRuntime,
  createRuntimeBrowserProfileArtifactStore,
  type StorageRuntimeOptions,
  type RuntimeOpsRepositories,
  type StorageRuntime,
} from './factory.js';
import type { FileArtifactStore } from '../../../domain/ports/file-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type {
  BrowserProfileArtifactStore,
  BrowserProfileArtifactMaterializer,
} from '../../../domain/ports/browser-profile-artifact-store.js';
import type { BrowserProfileSnapshotRepository } from '../../../domain/ports/browser-profile-snapshot.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import type { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import type { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import type { RuntimeLease } from '../../../domain/ports/runtime-lease.js';
import type { WorkerCoordinationRepository } from '../../../domain/ports/worker-coordination.js';
import { configurePendingInteractionDurability } from '../../../application/interactions/pending-interaction-durability.js';
import { ModelCredentialService } from '../../../application/model-credentials/model-credential-service.js';
import { logger } from '../../../infrastructure/logging/logger.js';

let runtime: StorageRuntime | null = null;

/**
 * Discriminates genuine storage-unavailability failures (Postgres down/absent,
 * network unreachable) from real migration/schema/auth/programming errors.
 *
 * Returning true only for connection-level failures keeps the YAML-only and
 * settings-only fallbacks safe: a misconfigured schema or bad credentials will
 * surface as an error instead of being silently masked as "offline".
 */
export function isStorageUnavailableError(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'EHOSTUNREACH' ||
    code === '3D000' ||
    code === '57P03' ||
    code === '08001' ||
    code === '08006'
  ) {
    return true;
  }
  const message = (err as { message?: string }).message;
  if (typeof message === 'string') {
    return /econnrefused|connection refused|connection terminated|could not connect|getaddrinfo|connect etimedout|database "[^"]*" does not exist/.test(
      message.toLowerCase(),
    );
  }
  return false;
}

export async function initializeRuntimeStorage(
  options: StorageRuntimeOptions = {},
): Promise<StorageRuntime> {
  const nextRuntime = createStorageRuntime(undefined, options);
  try {
    await nextRuntime.service.assertMigrationsCurrent();
    const capabilities = await nextRuntime.service.healthCheck();
    const failure = evaluatePostgresStorageCapabilities(capabilities);
    if (failure) {
      throw new Error([failure.summary, ...failure.details].join('\n'));
    }
    runtime = nextRuntime;
    configurePendingInteractionDurability({
      repository: nextRuntime.repositories.workerCoordination,
      liveTurns: nextRuntime.repositories.liveTurns,
      warn: (context, message) => logger.warn(context, message),
    });
    return nextRuntime;
  } catch (err) {
    await nextRuntime.service.close();
    throw err;
  }
}

export function getRuntimeStorage(): StorageRuntime {
  if (!runtime) {
    throw new Error('Runtime storage has not been initialized');
  }
  return runtime;
}

export function getRuntimeRepositories(): RuntimeOpsRepositories {
  return getRuntimeStorage().ops;
}

export function getRuntimeControlRepository(): PostgresControlPlaneRepository {
  return getRuntimeStorage().control;
}

export function getRuntimeEventExchange(): RuntimeEventExchange {
  return getRuntimeStorage().runtimeEvents;
}

export function getWorkerCoordinationRepository(): WorkerCoordinationRepository {
  return getRuntimeStorage().repositories.workerCoordination;
}

// Provider ids (route ids) with an ACTIVE configured Model Access credential for
// an app. Source for credential-driven model-family provider selection at the
// runtime spawn/job seams; resolved here so runtime callers do not reach into
// the adapter layer themselves.
export async function getConfiguredModelProvidersForApp(
  appId: string,
): Promise<Set<string>> {
  return new ModelCredentialService(
    getRuntimeStorage().repositories.modelCredentials,
  ).getConfiguredModelProviders({ appId: appId as never });
}

export async function tryAcquireRuntimeAdvisoryLease(
  key: string,
): Promise<RuntimeLease | undefined> {
  const client = await getRuntimeStorage().service.pool.connect();
  let released = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    if (!result.rows[0]?.acquired) {
      client.release();
      released = true;
      return undefined;
    }
    const lostHandlers = new Set<(err: Error) => void>();
    const notifyLost = (err: Error) => {
      if (released) return;
      released = true;
      for (const handler of [...lostHandlers]) handler(err);
      client.removeListener('error', notifyLost);
      client.removeListener('end', notifyEnd);
      try {
        client.release(err);
      } catch {
        // Best effort release after the lease connection is already broken.
      }
    };
    const notifyEnd = () => {
      notifyLost(new Error(`Runtime advisory lease connection ended: ${key}`));
    };
    client.once('error', notifyLost);
    client.once('end', notifyEnd);
    return {
      onLost: (handler) => {
        lostHandlers.add(handler);
      },
      release: async () => {
        if (released) return;
        released = true;
        client.removeListener('error', notifyLost);
        client.removeListener('end', notifyEnd);
        try {
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [key],
          );
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    if (!released) client.release(err instanceof Error ? err : undefined);
    throw err;
  }
}

export function getRuntimeFileArtifactStore(): FileArtifactStore {
  return getRuntimeStorage().fileArtifacts;
}

export function getRuntimeSkillArtifactStore(): SkillArtifactStore {
  return getRuntimeStorage().skillArtifacts;
}

export function getRuntimeBrowserProfileArtifactStore(): BrowserProfileArtifactStore &
  BrowserProfileArtifactMaterializer {
  getRuntimeStorage();
  return createRuntimeBrowserProfileArtifactStore();
}

export function getRuntimeBrowserProfileSnapshotRepository(): BrowserProfileSnapshotRepository {
  return getRuntimeStorage().browserProfileSnapshots;
}

export async function closeRuntimeStorage(): Promise<void> {
  const existing = runtime;
  runtime = null;
  configurePendingInteractionDurability(null);
  await existing?.liveTurnCommandWakeupSource.close();
  await existing?.liveAdmissionWakeupSource.close();
  await existing?.runtimeEventNotifier.close();
  await existing?.service.close();
}

/** @internal test hook */
export function _setRuntimeStorageForTest(nextRuntime: StorageRuntime): void {
  runtime = nextRuntime;
  const workerCoordination = nextRuntime.repositories?.workerCoordination;
  configurePendingInteractionDurability(
    workerCoordination
      ? {
          repository: workerCoordination,
          liveTurns: nextRuntime.repositories?.liveTurns ?? null,
        }
      : null,
  );
}
