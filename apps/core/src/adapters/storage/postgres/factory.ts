import path from 'node:path';

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
import { LocalFileArtifactBytes } from '../../artifacts/files/local-file-artifact-bytes.js';
import { LocalSkillArtifactStore } from '../../artifacts/skills/local-skill-artifact-store.js';
import type {
  RuntimeAgentSessionRepository,
  RuntimeChatMetadataRepository,
  RuntimeConversationRouteRepository,
  RuntimeJobRepository,
  RuntimeMessageRepository,
  RuntimeRouterStateRepository,
} from '../../../domain/repositories/ops-repo.js';
import type { FileArtifactStore } from '../../../domain/ports/file-artifact-store.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import { PostgresRuntimeRepositoryBundle } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import { PostgresFileArtifactStore } from './repositories/file-artifact-repository.postgres.js';
import type { PostgresStorageService } from './storage-service.js';
import { RuntimeEventExchange } from '../../../application/runtime-events/runtime-event-exchange.js';
import { PostgresRuntimeEventNotifier } from './runtime-event-notifier.postgres.js';
import type { AgentSession } from '../../../domain/sessions/sessions.js';

const FILE_ARTIFACTS_DIR_NAME = 'files';

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
  fileArtifacts: FileArtifactStore;
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
  const fileArtifacts = new PostgresFileArtifactStore(
    service.db,
    new LocalFileArtifactBytes(
      path.join(ARTIFACTS_DIR, FILE_ARTIFACTS_DIR_NAME),
    ),
  );
  const skillArtifacts = new LocalSkillArtifactStore(ARTIFACTS_DIR);
  return {
    service,
    ops,
    control,
    repositories,
    runtimeEvents,
    runtimeEventNotifier,
    fileArtifacts,
    skillArtifacts,
  };
}
