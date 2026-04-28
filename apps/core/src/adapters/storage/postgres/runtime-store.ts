import { createStorageRuntime, type StorageRuntime } from './factory.js';
import type { OpsRepository } from '../../../domain/repositories/ops-repo.js';
import type { ProviderArtifactStore } from '../../../domain/ports/provider-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import { evaluatePostgresStorageCapabilities } from './readiness.js';
import type { PostgresControlPlaneRepository } from './schema/control-plane-repo.postgres.js';

let runtime: StorageRuntime | null = null;

export async function initializeRuntimeStorage(): Promise<StorageRuntime> {
  const nextRuntime = createStorageRuntime();
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

export function getRuntimeOpsRepository(): OpsRepository {
  return getRuntimeStorage().ops;
}

export function getRuntimeControlRepository(): PostgresControlPlaneRepository {
  return getRuntimeStorage().control;
}

export function getRuntimeProviderArtifactStore(): ProviderArtifactStore {
  return getRuntimeStorage().providerArtifacts;
}

export function getRuntimeSkillArtifactStore(): SkillArtifactStore {
  return getRuntimeStorage().skillArtifacts;
}

export async function closeRuntimeStorage(): Promise<void> {
  const existing = runtime;
  runtime = null;
  await existing?.service.close();
}

/** @internal test hook */
export function _setRuntimeStorageForTest(nextRuntime: StorageRuntime): void {
  runtime = nextRuntime;
}

/** @internal test hook */
export function _setRuntimeOpsRepositoryForTest(ops: OpsRepository): void {
  runtime = {
    service: {
      migrate: async () => {},
      healthCheck: async () => ({ lexicalSearch: true, vectorSearch: false }),
      close: async () => {},
    } as StorageRuntime['service'],
    ops,
    control: {} as StorageRuntime['control'],
    repositories: {} as StorageRuntime['repositories'],
    providerArtifacts: {} as StorageRuntime['providerArtifacts'],
    skillArtifacts: {} as StorageRuntime['skillArtifacts'],
  };
}
