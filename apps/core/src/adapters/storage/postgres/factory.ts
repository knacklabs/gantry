import {
  createStorageService,
  type ResolvedStorageConfig,
} from './storage-service.js';
import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  STORAGE_POSTGRES_URL_ENV,
} from '../../../config/index.js';
import type { OpsRepository } from '../../../domain/repositories/ops-repo.js';
import { PostgresCanonicalOpsRepository } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './schema/control-plane-repo.postgres.js';
import type { PostgresStorageService } from './storage-service.js';

export interface StorageRuntime {
  service: PostgresStorageService;
  ops: OpsRepository;
  control: PostgresControlPlaneRepository;
}

export function resolveStorageConfigFromRuntime(): ResolvedStorageConfig {
  return {
    postgresUrl: STORAGE_POSTGRES_URL,
    postgresUrlEnv: STORAGE_POSTGRES_URL_ENV,
    postgresSchema: STORAGE_POSTGRES_SCHEMA,
  };
}

export function createStorageRuntime(
  config: ResolvedStorageConfig = resolveStorageConfigFromRuntime(),
): StorageRuntime {
  const service = createStorageService(config);
  const ops: OpsRepository = new PostgresCanonicalOpsRepository(
    service.pool,
    service.db,
  );
  const control = new PostgresControlPlaneRepository(service.pool);
  return {
    service,
    ops,
    control,
  };
}
