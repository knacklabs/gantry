import {
  createStorageService,
  type ResolvedStorageConfig,
} from './storage-service.js';
import {
  createPostgresDomainRepositories,
  type PostgresDomainRepositoryBundle,
} from './repositories/domain-repositories.postgres.js';
import {
  ARTIFACTS_DIR,
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  STORAGE_POSTGRES_URL_ENV,
  getRuntimeSettingsForConfig,
} from '../../../config/index.js';
import { PostgresProviderArtifactStore } from '../../artifacts/postgres/postgres-provider-artifact-store.js';
import { LocalSkillArtifactStore } from '../../artifacts/skills/local-skill-artifact-store.js';
import type { OpsRepository } from '../../../domain/repositories/ops-repo.js';
import type { ProviderArtifactStore } from '../../../domain/ports/provider-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import { PostgresCanonicalOpsRepository } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './schema/control-plane-repo.postgres.js';
import type { PostgresStorageService } from './storage-service.js';
import { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import { PostgresRuntimeEventNotifier } from './runtime-event-notifier.postgres.js';
import { PostgresRuntimeEventWebhookProjector } from './runtime-event-webhook-projector.postgres.js';

export interface StorageRuntime {
  service: PostgresStorageService;
  ops: OpsRepository;
  control: PostgresControlPlaneRepository;
  repositories: PostgresDomainRepositoryBundle;
  runtimeEvents: RuntimeEventExchange;
  runtimeEventNotifier: PostgresRuntimeEventNotifier;
  providerArtifacts: ProviderArtifactStore;
  skillArtifacts: SkillArtifactStore;
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
  const control = new PostgresControlPlaneRepository(service.pool);
  const repositories = createPostgresDomainRepositories(service.db);
  const runtimeEventNotifier = new PostgresRuntimeEventNotifier(service.pool);
  const runtimeEvents = new RuntimeEventExchange(
    repositories.runtimeEvents,
    runtimeEventNotifier,
    [new PostgresRuntimeEventWebhookProjector(control)],
  );
  const ops: OpsRepository = new PostgresCanonicalOpsRepository(
    service.pool,
    service.db,
    {
      runtimeEvents,
      sessions: sessionSettings,
    },
  );
  const providerArtifacts = new PostgresProviderArtifactStore(service.db, {
    artifactRoot: ARTIFACTS_DIR,
    defaultStorageType: 'local-filesystem',
  });
  const skillArtifacts = new LocalSkillArtifactStore(ARTIFACTS_DIR);
  return {
    service,
    ops,
    control,
    repositories,
    runtimeEvents,
    runtimeEventNotifier,
    providerArtifacts,
    skillArtifacts,
  };
}
