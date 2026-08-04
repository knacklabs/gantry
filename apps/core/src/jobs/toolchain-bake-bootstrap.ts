import {
  ARTIFACTS_DIR,
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  getDeploymentMode,
  getRuntimeSettingsForConfig,
} from '../config/index.js';
import { getRuntimeStorage } from '../adapters/storage/postgres/runtime-store.js';
import { createS3ArtifactClient } from '../adapters/artifacts/skills/s3-artifact-client.js';
import { LocalToolchainArtifactStore } from '../adapters/artifacts/toolchains/local-toolchain-artifact-store.js';
import { S3ToolchainArtifactStore } from '../adapters/artifacts/toolchains/s3-toolchain-artifact-store.js';
import type { ToolchainArtifactStore } from '../domain/ports/toolchain-artifact-store.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  enqueueToolchainBake,
  type EnqueueToolchainBakeResult,
} from './toolchain-bake-enqueue.js';
import {
  ToolchainBakeQueue,
  type ToolchainBakeQueueOptions,
} from './toolchain-bake-queue.js';
import type {
  ToolchainBakeExecutorDeps,
  ToolchainBakeOutcomeNotice,
} from './toolchain-bake-executor.js';
import { ToolchainBakeReaper } from './toolchain-bake-reaper.js';
import { PostgresToolchainManifestNotifier } from './toolchain-manifest-notify.js';

// Default npm registry the bake pins; overridable via runtime settings when the
// fleet uses a private mirror. Kept here (bootstrap) rather than a settings key
// to stay minimal for v1; broaden to settings when a real mirror is configured.
const DEFAULT_BAKE_REGISTRY = 'https://registry.npmjs.org/';

let activeQueue: ToolchainBakeQueue | null = null;
let activeReaper: ToolchainBakeReaper | null = null;

export interface ToolchainBakeBootstrapDeps {
  outcomeNotice: ToolchainBakeOutcomeNotice;
}

/**
 * Start the toolchain bake queue plus its reaper. Only meaningful in fleet
 * mode — the caller (and this function) no-op in workstation mode so bakes
 * never run there. Wire this from the runtime bootstrap after storage is
 * initialized. The reaper recovers rows stranded at `queued`/`baking` by a
 * worker hard-death, a rolling-deploy drain, or a dead-lettered delivery —
 * without it an approved dependency could silently never bake.
 */
export async function startToolchainBakeSubsystem(
  deps: ToolchainBakeBootstrapDeps,
): Promise<ToolchainBakeQueue | null> {
  if (getDeploymentMode() !== 'fleet') return null;
  if (activeQueue) return activeQueue;
  if (!STORAGE_POSTGRES_URL) {
    throw new Error(
      'Postgres URL is required to start the toolchain bake queue',
    );
  }
  const storage = getRuntimeStorage();
  const notifier = new PostgresToolchainManifestNotifier(
    storage.service.pool,
    (context, message) => logger.warn(context, message),
  );
  const executorDeps: ToolchainBakeExecutorDeps = {
    runtimeDependencies: storage.repositories.runtimeDependencies,
    toolchainStore: createToolchainArtifactStore(),
    commandRunner: (await import('./toolchain-bake-runner.js')).spawnNpmRunner,
    notifier,
    outcomeNotice: deps.outcomeNotice,
    registry: DEFAULT_BAKE_REGISTRY,
    logWarn: (context, message) => logger.warn(context, message),
  };
  const options: ToolchainBakeQueueOptions = {
    connectionString: STORAGE_POSTGRES_URL,
    schema: 'pgboss',
    applicationName: `gantry-${STORAGE_POSTGRES_SCHEMA}-toolchain-bake`,
    logError: (context, message) => logger.error(context, message),
    logInfo: (context, message) => logger.info(context, message),
  };
  const queue = new ToolchainBakeQueue(executorDeps, options);
  await queue.start();
  activeQueue = queue;
  const reaper = new ToolchainBakeReaper({
    runtimeDependencies: storage.repositories.runtimeDependencies,
    queue,
    notifier,
    logInfo: (context, message) => logger.info(context, message),
    logWarn: (context, message) => logger.warn(context, message),
  });
  reaper.start();
  activeReaper = reaper;
  return queue;
}

export async function stopToolchainBakeSubsystem(): Promise<void> {
  const reaper = activeReaper;
  activeReaper = null;
  await reaper?.stop();
  const queue = activeQueue;
  activeQueue = null;
  await queue?.stop();
}

/**
 * Enqueue a bake for an approved npm dependency request when in fleet mode.
 * Returns null in workstation mode (the caller keeps the existing local-install
 * behavior). Throws on a non-npm/system-package manifest with the ADR-2 error.
 */
export async function maybeEnqueueApprovedDependencyBake(input: {
  appId: string;
  packages: string[];
  requestedByAgentId?: string | null;
  approvedByConversationId?: string | null;
  approvedAt?: string | null;
}): Promise<EnqueueToolchainBakeResult | null> {
  if (getDeploymentMode() !== 'fleet') return null;
  const queue = activeQueue;
  if (!queue) {
    throw new Error(
      'Toolchain bake queue is not running; cannot enqueue dependency bake in fleet mode.',
    );
  }
  const storage = getRuntimeStorage();
  return enqueueToolchainBake(
    {
      runtimeDependencies: storage.repositories.runtimeDependencies,
      queue,
      registry: DEFAULT_BAKE_REGISTRY,
    },
    input,
  );
}

function createToolchainArtifactStore(): ToolchainArtifactStore {
  const artifactStore = getRuntimeSettingsForConfig().runtime.artifactStore;
  if (artifactStore.driver === 's3') {
    const { client, bucket } = createS3ArtifactClient({
      bucket: artifactStore.bucket ?? '',
      region: artifactStore.region,
      endpoint: artifactStore.endpoint,
      forcePathStyle: artifactStore.forcePathStyle,
    });
    return new S3ToolchainArtifactStore(client, bucket);
  }
  return new LocalToolchainArtifactStore(ARTIFACTS_DIR);
}
