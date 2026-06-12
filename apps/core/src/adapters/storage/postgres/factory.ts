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
import { S3SkillArtifactStore } from '../../artifacts/skills/s3-skill-artifact-store.js';
import { createS3ArtifactClient } from '../../artifacts/skills/s3-artifact-client.js';
import { LocalBrowserProfileArtifactStore } from '../../artifacts/browser-profiles/local-browser-profile-artifact-store.js';
import { S3BrowserProfileArtifactStore } from '../../artifacts/browser-profiles/s3-browser-profile-artifact-store.js';
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
import type {
  BrowserProfileArtifactStore,
  BrowserProfileArtifactMaterializer,
} from '../../../domain/ports/browser-profile-artifact-store.js';
import type { BrowserProfileSnapshotRepository } from '../../../domain/ports/browser-profile-snapshot.js';
import { PostgresRuntimeRepositoryBundle } from './schema/canonical-ops-repo.postgres.js';
import { PostgresControlPlaneRepository } from './repositories/control-plane-repository.postgres.js';
import { PostgresFileArtifactStore } from './repositories/file-artifact-repository.postgres.js';
import { PostgresBrowserProfileSnapshotRepository } from './repositories/browser-profile-snapshot-repository.postgres.js';
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
  browserProfileSnapshots: BrowserProfileSnapshotRepository;
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
  const skillArtifacts = createSkillArtifactStore();
  const browserProfileSnapshots = new PostgresBrowserProfileSnapshotRepository(
    service.db,
  );
  return {
    service,
    ops,
    control,
    repositories,
    runtimeEvents,
    runtimeEventNotifier,
    fileArtifacts,
    skillArtifacts,
    browserProfileSnapshots,
  };
}

function createSkillArtifactStore(): SkillArtifactStore {
  const artifactStore = getRuntimeSettingsForConfig().runtime.artifactStore;
  if (artifactStore.driver === 's3') {
    const { client, bucket } = createS3ArtifactClient({
      bucket: artifactStore.bucket ?? '',
      region: artifactStore.region,
      endpoint: artifactStore.endpoint,
      forcePathStyle: artifactStore.forcePathStyle,
    });
    return new S3SkillArtifactStore(client, bucket);
  }
  return new LocalSkillArtifactStore(ARTIFACTS_DIR);
}

export function createRuntimeBrowserProfileArtifactStore(): BrowserProfileArtifactStore &
  BrowserProfileArtifactMaterializer {
  const artifactStore = getRuntimeSettingsForConfig().runtime.artifactStore;
  if (artifactStore.driver === 's3') {
    const { client, bucket } = createS3ArtifactClient({
      bucket: artifactStore.bucket ?? '',
      region: artifactStore.region,
      endpoint: artifactStore.endpoint,
      forcePathStyle: artifactStore.forcePathStyle,
    });
    return new S3BrowserProfileArtifactStore(client, bucket);
  }
  return new LocalBrowserProfileArtifactStore(ARTIFACTS_DIR);
}
