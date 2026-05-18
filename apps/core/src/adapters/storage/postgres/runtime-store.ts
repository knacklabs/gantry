import {
  createStorageRuntime,
  type StorageRuntimeOptions,
  type RuntimeOpsRepositories,
  type StorageRuntime,
} from './factory.js';
import type { FileArtifactStore } from '../../../domain/ports/file-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import type { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import type { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import type { RuntimeLease } from '../../../domain/ports/runtime-lease.js';

let runtime: StorageRuntime | null = null;

export async function initializeRuntimeStorage(
  options: StorageRuntimeOptions = {},
): Promise<StorageRuntime> {
  const nextRuntime = createStorageRuntime(undefined, options);
  try {
    await nextRuntime.service.migrate();
    const capabilities = await nextRuntime.service.healthCheck();
    const failure = evaluatePostgresStorageCapabilities(capabilities);
    if (failure) {
      throw new Error([failure.summary, ...failure.details].join('\n'));
    }
    runtime = nextRuntime;
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

export async function closeRuntimeStorage(): Promise<void> {
  const existing = runtime;
  runtime = null;
  await existing?.runtimeEventNotifier.close();
  await existing?.service.close();
}

/** @internal test hook */
export function _setRuntimeStorageForTest(nextRuntime: StorageRuntime): void {
  runtime = nextRuntime;
}

/** @internal test hook */
export function _setRuntimeRepositoriesForTest(
  ops: RuntimeOpsRepositories,
): void {
  runtime = {
    service: {
      migrate: async () => {},
      healthCheck: async () => ({
        lexicalSearch: true,
        vectorSearch: false,
        runtimeEvents: true,
        eventBusOutbox: true,
      }),
      close: async () => {},
    } as StorageRuntime['service'],
    ops,
    control: {} as StorageRuntime['control'],
    repositories: {} as StorageRuntime['repositories'],
    runtimeEvents: {} as StorageRuntime['runtimeEvents'],
    runtimeEventNotifier: {
      close: async () => {},
    } as StorageRuntime['runtimeEventNotifier'],
    fileArtifacts: {} as StorageRuntime['fileArtifacts'],
    skillArtifacts: {} as StorageRuntime['skillArtifacts'],
  };
}
