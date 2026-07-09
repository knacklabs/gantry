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
  GANTRY_HOME,
  createDefaultRuntimeSettings,
  getRuntimeSettingsForConfig,
  resolveRuntimeStorageConfig,
  resolveRuntimeStorageConfigFromSettings,
  type RuntimeSettings,
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
import {
  PostgresLiveAdmissionNotifier,
  PostgresLiveAdmissionWakeupSource,
  PostgresLiveTurnCommandNotifier,
  PostgresLiveTurnCommandWakeupSource,
} from './live-admission-notify.postgres.js';
import type {
  LiveAdmissionWakeupSource,
  LiveTurnCommandWakeupSource,
} from '../../../domain/ports/live-turns.js';

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
  liveAdmissionWakeupSource: LiveAdmissionWakeupSource;
  liveTurnCommandWakeupSource: LiveTurnCommandWakeupSource;
  fileArtifacts: FileArtifactStore;
  skillArtifacts: SkillArtifactStore;
  browserProfileSnapshots: BrowserProfileSnapshotRepository;
}

export interface StorageRuntimeOptions {
  storageConfig?: ResolvedStorageConfig;
  runtimeSettings?: RuntimeSettings;
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
  const runtimeHome = process.env.GANTRY_HOME?.trim() || GANTRY_HOME;
  const config = resolveRuntimeStorageConfig(runtimeHome, runtimeHome);
  return {
    postgresUrl: config.postgresUrl,
    postgresUrlEnv: config.postgresUrlEnv,
    postgresSchema: config.postgresSchema,
    postgresPlaintextHostAllowlist: config.postgresPlaintextHostAllowlist,
  };
}

export function createStorageRuntime(
  config?: ResolvedStorageConfig,
  options: StorageRuntimeOptions = {},
): StorageRuntime {
  const service = createStorageService(
    options.storageConfig ??
      config ??
      resolveStorageConfigFromSettings(options.runtimeSettings) ??
      resolveStorageConfigFromRuntime(),
  );
  const runtimeSettings =
    options.runtimeSettings ?? getRuntimeSettingsForStorageRuntime();
  const sessionSettings = runtimeSettings.agent.sessions;
  const control = new PostgresControlPlaneRepository(service.db);
  const liveTurnCommandNotifier = new PostgresLiveTurnCommandNotifier(
    service.pool,
  );
  const repositories = createPostgresDomainRepositories(
    service.db,
    service.pool,
    { liveTurnCommandNotifier },
  );
  const runtimeEventNotifier = new PostgresRuntimeEventNotifier(service.pool);
  const liveAdmissionNotifier = new PostgresLiveAdmissionNotifier(service.pool);
  const liveAdmissionWakeupSource = new PostgresLiveAdmissionWakeupSource(
    service.pool,
  );
  const liveTurnCommandWakeupSource = new PostgresLiveTurnCommandWakeupSource(
    service.pool,
  );
  const runtimeEvents = new RuntimeEventExchange(
    repositories.runtimeEvents,
    runtimeEventNotifier,
  );
  const ops: RuntimeOpsRepositories = new PostgresRuntimeRepositoryBundle(
    service.pool,
    service.db,
    {
      runtimeEvents,
      liveAdmissionNotifier,
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
  const skillArtifacts = createSkillArtifactStore(runtimeSettings);
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
    liveAdmissionWakeupSource,
    liveTurnCommandWakeupSource,
    fileArtifacts,
    skillArtifacts,
    browserProfileSnapshots,
  };
}

function resolveStorageConfigFromSettings(
  runtimeSettings: RuntimeSettings | undefined,
): ResolvedStorageConfig | undefined {
  if (!runtimeSettings) return undefined;
  return resolveRuntimeStorageConfigFromSettings({
    postgresUrlEnv: runtimeSettings.storage.postgres.urlEnv,
    postgresSchema: runtimeSettings.storage.postgres.schema,
  });
}

function createSkillArtifactStore(
  runtimeSettings = getRuntimeSettingsForStorageRuntime(),
): SkillArtifactStore {
  const artifactStore = runtimeSettings.runtime.artifactStore;
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
  const artifactStore =
    getRuntimeSettingsForStorageRuntime().runtime.artifactStore;
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

function getRuntimeSettingsForStorageRuntime(): RuntimeSettings {
  try {
    return getRuntimeSettingsForConfig();
  } catch {
    return createDefaultRuntimeSettings();
  }
}
