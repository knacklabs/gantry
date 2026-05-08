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
import type {
  RuntimeAgentSessionRepository,
  RuntimeChatMetadataRepository,
  RuntimeConversationRouteRepository,
  RuntimeJobRepository,
  RuntimeMessageRepository,
  RuntimeRouterStateRepository,
} from '../../../domain/repositories/ops-repo.js';
import type { ProviderArtifactStore } from '../../../domain/ports/provider-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import { PostgresRuntimeRepositoryBundle } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import type { PostgresStorageService } from './storage-service.js';
import { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import { PostgresRuntimeEventNotifier } from './runtime-event-notifier.postgres.js';
import type { AgentSession } from '../../../domain/sessions/sessions.js';

export type RuntimeOpsRepositories = RuntimeChatMetadataRepository &
  RuntimeMessageRepository &
  RuntimeJobRepository &
  RuntimeRouterStateRepository &
  RuntimeAgentSessionRepository &
  RuntimeConversationRouteRepository;

export interface StorageRuntime {
  service: PostgresStorageService;
  ops: RuntimeOpsRepositories;
  control: PostgresControlPlaneRepository;
  repositories: PostgresDomainRepositoryBundle;
  runtimeEvents: RuntimeEventExchange;
  runtimeEventNotifier: PostgresRuntimeEventNotifier;
  providerArtifacts: ProviderArtifactStore;
  skillArtifacts: SkillArtifactStore;
}

export interface StorageRuntimeOptions {
  loadSessionAppMemoryItems?: (input: {
    session: AgentSession;
    limit: number;
    conversationKind?: string;
    query?: string;
  }) => Promise<
    Array<{
      id: string;
      kind: string;
      key: string;
      value: string;
      subject: Record<string, unknown>;
    }>
  >;
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
  options: StorageRuntimeOptions = {},
): StorageRuntime {
  const service = createStorageService(config);
  const sessionSettings = getRuntimeSettingsForConfig().agent.sessions;
  const control = new PostgresControlPlaneRepository(service.db);
  const repositories = createPostgresDomainRepositories(
    service.db,
    service.pool,
  );
  const runtimeEventNotifier = new PostgresRuntimeEventNotifier(service.pool);
  const runtimeEvents = new RuntimeEventExchange(
    repositories.runtimeEvents,
    runtimeEventNotifier,
  );
  const ops: RuntimeOpsRepositories = new PostgresRuntimeRepositoryBundle(
    service.pool,
    service.db,
    {
      runtimeEvents,
      sessions: {
        ...sessionSettings,
        loadAppMemoryItems: options.loadSessionAppMemoryItems,
      },
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
