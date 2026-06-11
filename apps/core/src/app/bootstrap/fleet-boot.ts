import type { Pool } from 'pg';

import { createS3ArtifactClient } from '../../adapters/artifacts/skills/s3-artifact-client.js';
import { S3SkillArtifactStore } from '../../adapters/artifacts/skills/s3-skill-artifact-store.js';
import { LocalToolchainArtifactStore } from '../../adapters/artifacts/toolchains/local-toolchain-artifact-store.js';
import { S3ToolchainArtifactStore } from '../../adapters/artifacts/toolchains/s3-toolchain-artifact-store.js';
import { getRuntimeStorage } from '../../adapters/storage/postgres/runtime-store.js';
import {
  ARTIFACTS_DIR,
  getRuntimeSettingsForConfig,
} from '../../config/index.js';
import {
  importWorkstationSettings,
  settingsFromRevisionDocument,
} from '../../config/settings/settings-import-service.js';
import { PostgresSettingsRevisionWakeupSource } from '../../config/settings/settings-revision-notify.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillArtifactMaterializer } from '../../domain/ports/skill-artifact-store.js';
import type { ToolchainArtifactMaterializer } from '../../domain/ports/toolchain-artifact-store.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  startToolchainBakeSubsystem,
  stopToolchainBakeSubsystem,
} from '../../jobs/toolchain-bake-bootstrap.js';
import type { ToolchainBakeOutcomeNotice } from '../../jobs/toolchain-bake-executor.js';
import { PostgresManifestWakeupSource } from '../../jobs/toolchain-manifest-listener.js';
import { currentWorkerInstanceId } from '../../jobs/worker-identity.js';
import { WorkerCapabilityReconciler } from '../../jobs/worker-capability-reconciler.js';
import {
  markSettingsLoaded,
  markSettingsNotLoaded,
} from '../../runtime/settings-load-state.js';
import { SettingsRevisionListener } from '../../runtime/settings-revision-listener.js';
import type { RuntimeApp } from './runtime-app.js';

const SEED_COMMAND = 'gantry settings import --file settings.yaml';

export interface FleetSettingsResult {
  loaded: boolean;
  revision: number | null;
}

/**
 * Fetch the latest settings revision and render it to the runtime settings home
 * so the existing `loadRuntimeSettings` path reads the fleet desired state. When
 * no revision has been seeded yet, mark settings NOT loaded (so `/readyz` goes
 * red via the existing settings check) and log the exact seed command. This runs
 * before runtime services need settings (ADR-3 fleet boot).
 */
export async function prepareFleetSettings(input: {
  appId: AppId;
  runtimeHome: string;
  app: RuntimeApp;
}): Promise<FleetSettingsResult> {
  const storage = getRuntimeStorage();
  const latest =
    await storage.repositories.settingsRevisions.getLatestSettingsRevision(
      input.appId,
    );
  if (!latest) {
    markSettingsNotLoaded();
    logger.warn(
      { appId: input.appId, seedCommand: SEED_COMMAND },
      `Fleet worker has no settings revision yet; /readyz stays red until ` +
        `desired state is seeded. Run: ${SEED_COMMAND}`,
    );
    return { loaded: false, revision: null };
  }
  const settings = settingsFromRevisionDocument(latest.settingsDocument);
  // Apply through the single shared import path (validate → write settings.yaml
  // → reconcile → reload runtime state), the same path the watcher and CLI use.
  await importWorkstationSettings(
    {
      runtimeHome: input.runtimeHome,
      ops: storage.ops,
      repositories: storage.repositories,
      appId: input.appId,
      reloadRuntimeState: () => input.app.loadState(),
    },
    settings,
  );
  markSettingsLoaded();
  logger.info(
    { appId: input.appId, revision: latest.revision },
    'Loaded fleet settings from revision',
  );
  return { loaded: true, revision: latest.revision };
}

export interface FleetSubsystems {
  stop: () => Promise<void>;
  settingsRevisionListener: SettingsRevisionListener;
}

/**
 * Start the fleet-only worker subsystems: the toolchain bake queue, the worker
 * capability reconciler, and the settings revision listener. Each owns stoppable
 * timers/LISTEN clients; {@link FleetSubsystems.stop} tears them all down for
 * the drain sequence. Workstation never calls this.
 */
export async function startFleetSubsystems(input: {
  app: RuntimeApp;
  appId: AppId;
  runtimeHome: string;
  pool: Pool;
  /** Best-effort delivery for bake outcome notices to the approval conversation. */
  sendMessage: (conversationJid: string, text: string) => Promise<void>;
}): Promise<FleetSubsystems> {
  const storage = getRuntimeStorage();
  const workerInstanceId = currentWorkerInstanceId() ?? `fleet-${process.pid}`;

  const bakeQueue = await startToolchainBakeSubsystem({
    outcomeNotice: buildBakeOutcomeNotice(input.sendMessage),
  });

  const reconciler = new WorkerCapabilityReconciler({
    appId: input.appId,
    workerInstanceId,
    runtimeDependencies: storage.repositories.runtimeDependencies,
    skills: storage.repositories.skills,
    toolchainMaterializer: buildToolchainMaterializer(),
    skillMaterializer: buildSkillMaterializer(),
    workerRegistry: storage.repositories.workerCoordination,
    wakeupSource: new PostgresManifestWakeupSource(
      input.pool,
      (context, message) => logger.warn(context, message),
    ),
    localRoot: ARTIFACTS_DIR,
    onIntegrityError: (event) => {
      logger.error(
        { ...event },
        'Artifact integrity failure; artifact quarantined and not advertised',
      );
    },
    logWarn: (context, message) => logger.warn(context, message),
  });
  reconciler.start();

  const settingsRevisionListener = new SettingsRevisionListener({
    appId: input.appId,
    runtimeHome: input.runtimeHome,
    settingsRevisions: storage.repositories.settingsRevisions,
    ops: storage.ops,
    repositories: storage.repositories,
    wakeupSource: new PostgresSettingsRevisionWakeupSource(
      input.pool,
      (context, message) => logger.warn(context, message),
    ),
    reloadRuntimeState: () => input.app.loadState(),
    onSkewAlert: (alert) => {
      logger.error(
        { ...alert },
        'Settings revision needs a newer reader version; holding last-applied ' +
          'revision until this worker is upgraded',
      );
    },
    logWarn: (context, message) => logger.warn(context, message),
    logInfo: (context, message) => logger.info(context, message),
  });
  settingsRevisionListener.markAwaitingFirstRevision();
  settingsRevisionListener.start();

  return {
    settingsRevisionListener,
    stop: async () => {
      await settingsRevisionListener.stop();
      await reconciler.stop();
      if (bakeQueue) await stopToolchainBakeSubsystem();
    },
  };
}

/**
 * One concise best-effort outcome message per terminal bake state to the
 * approval conversation that requested the dependency. Delivery failures are
 * logged, never thrown — a notice must not fail (or retry) the bake.
 * Exported for unit tests.
 */
export function buildBakeOutcomeNotice(
  sendMessage: (conversationJid: string, text: string) => Promise<void>,
): ToolchainBakeOutcomeNotice {
  const deliver = async (input: {
    dependency: {
      approvedByConversationId: string | null;
      manifestHash: string;
    };
    text: string;
    missingConversationMessage: string;
    deliveryFailureMessage: string;
  }): Promise<void> => {
    const conversationJid = input.dependency.approvedByConversationId;
    if (!conversationJid) {
      logger.warn(
        { manifestHash: input.dependency.manifestHash },
        input.missingConversationMessage,
      );
      return;
    }
    try {
      await sendMessage(conversationJid, input.text);
    } catch (err) {
      logger.warn(
        { err, conversationJid, manifestHash: input.dependency.manifestHash },
        input.deliveryFailureMessage,
      );
    }
  };
  return {
    sendSuccessNotice: async ({ dependency }) =>
      deliver({
        dependency,
        text:
          `Dependency ${dependency.requestedPackages.join(', ')} is baked and ` +
          'rolling out to workers — ready to use in about a minute. Re-ask ' +
          "the agent when you're ready.",
        missingConversationMessage:
          'Toolchain bake succeeded but has no approval conversation to notify',
        deliveryFailureMessage:
          'Failed to deliver toolchain bake success notice',
      }),
    sendFailureNotice: async ({ dependency, reason }) =>
      deliver({
        dependency,
        text: `Dependency bake failed: ${reason}`,
        missingConversationMessage:
          'Toolchain bake failed but has no approval conversation to notify',
        deliveryFailureMessage:
          'Failed to deliver toolchain bake failure notice',
      }),
  };
}

function buildToolchainMaterializer(): ToolchainArtifactMaterializer {
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

function buildSkillMaterializer(): SkillArtifactMaterializer {
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
  // Local driver fleet rehearsal: object-store skills are not produced, so the
  // reconciler never materializes one. A call here would mean a misconfigured
  // skill row; fail loudly rather than silently activate unverified bytes.
  return {
    materializeSkillArtifact: async () => {
      throw new Error(
        'Object-store skill materialization requested under the local artifact ' +
          'store driver; configure runtime.artifact_store.driver=s3 for fleet.',
      );
    },
  };
}
