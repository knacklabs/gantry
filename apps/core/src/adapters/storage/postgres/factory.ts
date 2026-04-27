import {
  createStorageService,
  type ResolvedStorageConfig,
} from './storage-service.js';
import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from './repositories/domain-repositories.postgres.js';
import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  STORAGE_POSTGRES_URL_ENV,
  getRuntimeSettingsForConfig,
} from '../../../config/index.js';
import type { OpsRepository } from '../../../domain/repositories/ops-repo.js';
import { PostgresCanonicalOpsRepository } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './schema/control-plane-repo.postgres.js';
import type { PostgresStorageService } from './storage-service.js';

export interface StorageRuntime {
  service: PostgresStorageService;
  ops: OpsRepository;
  control: PostgresControlPlaneRepository;
  repositories: PostgresDomainRepositoryBundle;
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
  const sessionSettings = getRuntimeSettingsForConfig().agent.sessions;
  const ops: OpsRepository = new PostgresCanonicalOpsRepository(
    service.pool,
    service.db,
    { sessions: sessionSettings },
  );
  const control = new PostgresControlPlaneRepository(service.pool);
  const repositories = createPostgresDomainRepositories(service.db);
  return {
    service,
    ops,
    control,
    repositories,
  };
}
