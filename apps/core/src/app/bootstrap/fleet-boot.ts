import type { Pool } from 'pg';

import { createS3ArtifactClient } from '../../adapters/artifacts/skills/s3-artifact-client.js';
import { S3SkillArtifactStore } from '../../adapters/artifacts/skills/s3-skill-artifact-store.js';
import { LocalToolchainArtifactStore } from '../../adapters/artifacts/toolchains/local-toolchain-artifact-store.js';
import { S3ToolchainArtifactStore } from '../../adapters/artifacts/toolchains/s3-toolchain-artifact-store.js';
import {
  getRuntimeBrowserProfileArtifactStore,
  getRuntimeBrowserProfileSnapshotRepository,
  getRuntimeStorage,
} from '../../adapters/storage/postgres/runtime-store.js';
import {
  ARTIFACTS_DIR,
  getRuntimeSettingsForConfig,
} from '../../config/index.js';
import {
  CURRENT_SETTINGS_READER_VERSION,
  importWorkstationSettings,
  settingsFromRevisionDocument,
} from '../../config/settings/settings-import-service.js';
import { PostgresSettingsRevisionWakeupSource } from '../../config/settings/settings-revision-notify.js';
import type { AppId } from '../../domain/app/app.js';
import { isDraining } from './draining-state.js';
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
import { registerBrowserProfileSync } from '../../runtime/browser-profile-sync.js';
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
  if (latest.minReaderVersion > CURRENT_SETTINGS_READER_VERSION) {
    markSettingsNotLoaded();
    logger.error(
      {
        appId: input.appId,
        revision: latest.revision,
        minReaderVersion: latest.minReaderVersion,
        readerVersion: CURRENT_SETTINGS_READER_VERSION,
      },
      'Fleet settings revision requires a newer reader version; holding boot ' +
        'until this worker is upgraded',
    );
    return { loaded: false, revision: latest.revision };
  }
  const settings = settingsFromRevisionDocument(latest.settingsDocument);
  // Apply through the single shared import path (validate → write settings.yaml
  // → reconcile → reload runtime state), the same path the watcher and CLI use.
  // Writing settings.yaml here is an internal loader reuse so the existing
  // `loadRuntimeSettings` path can read fleet desired state; the file is NOT the
  // fleet wire contract (the typed document in `settings_revisions` is).
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
 *
 * When `settingsLoaded` is false (first fleet boot with no seeded revision) the
 * bake queue and capability reconciler are HELD — only the revision listener
 * starts, because it is the thing that eventually loads settings. The first
 * applied revision starts the held subsystems and invokes `onSettingsReady`
 * (app boot uses it to release the held scheduler start).
 */
export async function startFleetSubsystems(input: {
  app: RuntimeApp;
  appId: AppId;
  runtimeHome: string;
  pool: Pool;
  /** Best-effort delivery for bake outcome notices to the approval conversation. */
  sendMessage: (conversationJid: string, text: string) => Promise<void>;
  /**
   * Whether this process role runs the toolchain bake queue + reaper (all,
   * job-worker). Defaults true so existing fleet callers are unchanged.
   */
  bakeExecution?: boolean;
  /**
   * Whether this process role materializes/advertises capabilities via the
   * worker capability reconciler (all, live-worker, job-worker). Defaults true.
   */
  capabilityReconciliation?: boolean;
  /** Whether a settings revision was applied at boot (prepareFleetSettings). */
  settingsLoaded: boolean;
  /** Released once, with the held subsystems, on the first applied revision. */
  onSettingsReady?: () => Promise<void> | void;
}): Promise<FleetSubsystems> {
  const storage = getRuntimeStorage();
  const workerInstanceId = currentWorkerInstanceId() ?? `fleet-${process.pid}`;
  const bakeExecution = input.bakeExecution ?? true;
  const capabilityReconciliation = input.capabilityReconciliation ?? true;

  const registerBrowserSync = (): void => {
    // Cross-worker browser profile snapshot/restore. Registered only after
    // fleet settings are loaded so artifact storage resolves to the shared
    // configured store instead of the default workstation-local store.
    registerBrowserProfileSync({
      store: getRuntimeBrowserProfileArtifactStore(),
      repository: getRuntimeBrowserProfileSnapshotRepository(),
      workerInstanceId,
    });
  };

  let bakeQueueStarted = false;
  let reconciler: WorkerCapabilityReconciler | undefined;
  let capabilitySubsystemsStarted = false;
  const startCapabilitySubsystems = async (): Promise<void> => {
    if (capabilitySubsystemsStarted) return;
    capabilitySubsystemsStarted = true;
    if (bakeExecution) {
      bakeQueueStarted =
        (await startToolchainBakeSubsystem({
          outcomeNotice: buildBakeOutcomeNotice(input.sendMessage),
        })) !== null;
    }
    if (!capabilityReconciliation) return;
    reconciler = new WorkerCapabilityReconciler({
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
  };

  if (input.settingsLoaded) {
    registerBrowserSync();
    await startCapabilitySubsystems();
  } else {
    registerBrowserProfileSync(null);
    logger.warn(
      'Fleet worker has no settings revision; bake queue and capability ' +
        'reconciler are held until the first revision is applied',
    );
  }

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
    onFirstRevisionApplied: async () => {
      // No-op when everything already started at boot (settingsLoaded).
      if (capabilitySubsystemsStarted) return;
      // A revision NOTIFY can land mid-drain, after shutdown stopped the
      // scheduler but before it tears down this listener. Do not re-arm the
      // held scheduler/capability subsystems on an instance the ALB already
      // pulled from rotation.
      if (isDraining()) return;
      registerBrowserSync();
      await startCapabilitySubsystems();
      await input.onSettingsReady?.();
      logger.info(
        'First settings revision applied; held fleet services started',
      );
    },
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
  // Only a boot without an applied revision is awaiting one; flagging the
  // already-loaded case would flap /readyz red until the listener's first pass.
  if (!input.settingsLoaded) {
    settingsRevisionListener.markAwaitingFirstRevision();
  }
  settingsRevisionListener.start();

  return {
    settingsRevisionListener,
    stop: async () => {
      registerBrowserProfileSync(null);
      await settingsRevisionListener.stop();
      await reconciler?.stop();
      if (bakeQueueStarted) await stopToolchainBakeSubsystem();
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
    sendFailureNotice: async ({ dependency }) =>
      deliver({
        dependency,
        text: "I couldn't prepare that dependency. I left it unavailable; try again after the setup issue is fixed.",
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
