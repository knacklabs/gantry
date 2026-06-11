import {
  installGlobalErrorHandlers,
  logger,
} from '../infrastructure/logging/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { getDefaultRuntimeApp } from './bootstrap/runtime-app.js';
import {
  startRuntimeServices,
  beginDrainingLiveTurnAdmission,
  shutdownLiveTurnAuthority,
  stopLiveTurnRecoveryLoop,
  stopMessagePollingLoop,
} from './bootstrap/runtime-services.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { runStartup } from './bootstrap/startup.js';
import {
  closeRuntimeStorage,
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
  tryAcquireRuntimeAdvisoryLease,
} from '../adapters/storage/postgres/runtime-store.js';
import { startControlServer } from '../control/server/index.js';
import { stopSchedulerLoop } from '../jobs/scheduler.js';
import { stopOutboundDeliveryRecoveryLoop } from '../jobs/outbound-delivery-recovery.js';
import { publishBrowserJobActivityEvent } from '../jobs/browser-activity-events.js';
import {
  GANTRY_HOME,
  getDeploymentMode,
  getRuntimeQueueConfig,
  loadRuntimeSettings,
} from '../config/index.js';
import { getBrowserStatus } from '../runtime/browser-capability.js';
import { startSettingsReloadWatcher } from '../runtime/settings-reload-watcher.js';
import {
  prepareFleetSettings,
  startFleetSubsystems,
  type FleetSubsystems,
} from './bootstrap/fleet-boot.js';
import type { AppId } from '../domain/app/app.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';
import { startLiveTurnHostLeaseAcquisition } from './bootstrap/live-turn-host.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import { defaultHostnameLookup } from '../infrastructure/network/hostname-lookup.js';

export { escapeXml, formatMessages } from '../messaging/router.js';
export {
  getAvailableGroups,
  _setConversationRoutes,
} from './bootstrap/runtime-app.js';

export interface StartGantryRuntimeOptions {
  skipPreflight?: boolean;
  mcpHostnameLookup?: HostnameLookup;
}

export async function startGantryRuntime(
  options: StartGantryRuntimeOptions = {},
): Promise<void> {
  const mcpHostnameLookup = options.mcpHostnameLookup ?? defaultHostnameLookup;
  if (!options.skipPreflight) {
    const validation = await validateRuntimePreflightWithStorage(GANTRY_HOME);
    if (!validation.ok && validation.failure) {
      throw new Error(formatRuntimePreflightFailure(validation.failure));
    }
  }

  const app = getDefaultRuntimeApp({
    mcpHostnameLookup: () => mcpHostnameLookup,
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
  });
  const channelWiring = createChannelWiring(app, {
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
  });
  const controlServerRef: {
    current?: {
      close: () => Promise<void>;
    };
  } = {};
  app.setChannelRuntime({
    hasChannel: channelWiring.hasChannel,
    supportsStreaming: channelWiring.supportsStreaming,
    supportsProgress: channelWiring.supportsProgress,
    sendMessage: (chatJid, rawText, options) =>
      channelWiring.sendMessage(chatJid, rawText, {
        durability: 'required',
        messageOptions: options,
      }),
    sendStreamingChunk: channelWiring.sendStreamingChunk,
    resetStreaming: channelWiring.resetStreaming,
    setTyping: channelWiring.setTyping,
    sendProgressUpdate: channelWiring.sendProgressUpdate,
    isControlApproverAllowed: channelWiring.isControlApproverAllowed,
  });

  let { runtimeSettings } = await runStartup(app);
  const storage = getRuntimeStorage();
  const isFleet = getDeploymentMode() === 'fleet';

  // Fleet desired state lives in Postgres (ADR-3). Before runtime services need
  // settings, fetch the latest revision, render it to the runtime home, and
  // reconcile it through the shared import path. No revision yet → settings NOT
  // loaded (red /readyz) + a log naming the seed command. The file watcher is
  // disabled in fleet (explicit CLI import only); workstation is unchanged.
  if (isFleet) {
    const prepared = await prepareFleetSettings({
      appId: 'default' as AppId,
      runtimeHome: GANTRY_HOME,
      app,
    });
    if (prepared.loaded) {
      runtimeSettings = loadRuntimeSettings(GANTRY_HOME);
    }
  }
  const settingsWatcher = isFleet
    ? { close: () => {} }
    : startSettingsReloadWatcher({
        runtimeHome: GANTRY_HOME,
        app,
        ops: storage.ops,
        repositories: storage.repositories,
      });
  let fleetSubsystems: FleetSubsystems | undefined;
  const browserToolModulePath = [
    '..',
    'adapters',
    'browser',
    'browser-direct-driver.js',
  ].join('/');
  let browserToolModule: Promise<any> | undefined;
  const loadBrowserToolModule = () =>
    (browserToolModule ??= import(browserToolModulePath));
  const approvedCommandModulePath = [
    '..',
    'adapters',
    'sandbox',
    'approved-command-runner.js',
  ].join('/');
  let approvedCommandModule: Promise<any> | undefined;
  const loadApprovedCommandModule = () =>
    (approvedCommandModule ??= import(approvedCommandModulePath));

  const liveTurnHostLeaseManager = startLiveTurnHostLeaseAcquisition({
    runtimeSettings,
    leases: { tryAcquire: tryAcquireRuntimeAdvisoryLease },
  });

  installShutdownHandlers({
    queue: app.queue,
    drainDeadlineMs: getRuntimeQueueConfig().drainDeadlineMs,
    disconnectChannels: channelWiring.disconnectChannels,
    closeControlServer: async () => {
      await controlServerRef.current?.close();
    },
    closeStorage: closeRuntimeStorage,
    closeScheduler: stopSchedulerLoop,
    closeOutboundDeliveryRecovery: stopOutboundDeliveryRecoveryLoop,
    closeLiveTurnAdmission: beginDrainingLiveTurnAdmission,
    closeMessagePolling: stopMessagePollingLoop,
    closeLiveTurnRecovery: async () => {
      stopLiveTurnRecoveryLoop();
    },
    closeLiveTurnAuthority: shutdownLiveTurnAuthority,
    closeSettingsWatcher: settingsWatcher.close,
    closeLiveTurnHostLease: async () => {
      await liveTurnHostLeaseManager.stop();
    },
    closeFleetSubsystems: async () => {
      await fleetSubsystems?.stop();
    },
    closeBrowserToolBackends: async () =>
      (await loadBrowserToolModule()).closeBrowserToolBackends(),
  });

  // The standby acquirer runs in the background; a job-only worker boots fully
  // while it waits for the live-host lease (fleet v1: 1 live host + N workers).
  // Lease transitions (acquired/lost) start and stop the live-host services
  // in-process via the manager handed to startRuntimeServices below.
  try {
    if (!runtimeSettings.runtime.liveTurns.enabled) {
      logger.info(
        'Live-turn host lease disabled by runtime.live_turns.enabled=false; connecting channels in outbound-only mode',
      );
    }
    await channelWiring.connectEnabledChannels(runtimeSettings);

    if (!channelWiring.hasConnectedChannels()) {
      logger.warn(
        'No channels connected; runtime will continue without inbound/outbound channel delivery',
      );
    }

    await startRuntimeServices(
      {
        app,
        channelWiring,
        liveTurnsEnabled: runtimeSettings.runtime.liveTurns.enabled,
        liveTurnHost: liveTurnHostLeaseManager,
      },
      {
        mcpHostnameLookup,
        opsRepository: storage.ops,
        getToolRepository: () => storage.repositories.tools,
        getSkillRepository: () => storage.repositories.skills,
        getMcpServerRepository: () => storage.repositories.mcpServers,
        getCapabilitySecretRepository: () =>
          storage.repositories.capabilitySecrets,
        runApprovedCommand: async (input) =>
          (await loadApprovedCommandModule()).runApprovedSandboxCommand(input),
        getSkillArtifactStore: getRuntimeSkillArtifactStore,
        getPermissionRepository: () => storage.repositories.permissions,
        settingsRepositories: storage.repositories,
        getOutboundDeliveryRepository: () =>
          storage.repositories.outboundDeliveries,
        getWorkerCoordinationRepository: () =>
          storage.repositories.workerCoordination,
        getLiveTurnRepository: () => storage.repositories.liveTurns,
        getRuntimeDependencyRepository: () =>
          storage.repositories.runtimeDependencies,
        publishRuntimeEvent: async (event) => {
          await getRuntimeEventExchange().publish(event);
        },
        callBrowserTool: async (input) =>
          (await loadBrowserToolModule()).callBrowserTool(input),
        publishBrowserJobActivity: async (input) => {
          const controlRepository = getRuntimeControlRepository();
          await publishBrowserJobActivityEvent({
            activity: input,
            getJobById: (jobId) => storage.ops.getJobById(jobId),
            controlRepository,
            publishRuntimeEvent: async (event) => {
              await getRuntimeEventExchange().publish(event);
            },
            logger,
          });
        },
        closeBrowserToolBackends: async (profileName) =>
          (await loadBrowserToolModule()).closeBrowserToolBackends(profileName),
      },
    );

    // Fleet-only worker subsystems start after runtime services register this
    // worker instance: the toolchain bake queue, the capability reconciler, and
    // the settings revision listener (NOTIFY + poll, applying new revisions and
    // holding on reader-version skew). Stopped in the drain sequence.
    if (isFleet) {
      fleetSubsystems = await startFleetSubsystems({
        app,
        appId: 'default' as AppId,
        runtimeHome: GANTRY_HOME,
        pool: storage.service.pool,
        sendMessage: async (conversationJid, text) => {
          await channelWiring.sendMessage(conversationJid, text, {
            durability: 'required',
          });
        },
      });
    }

    controlServerRef.current = startControlServer({
      app,
      getBrowserStatus,
      sendConversationIngressProjection: async (input) => {
        await channelWiring.sendMessage(input.conversationJid, input.text, {
          durability: 'required',
          throwOnMissing: true,
          messageOptions: input.threadId
            ? { threadId: input.threadId }
            : undefined,
        });
      },
    });
  } catch (err) {
    await liveTurnHostLeaseManager.stop();
    await fleetSubsystems?.stop();
    throw err;
  }
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  installGlobalErrorHandlers(logger);
  startGantryRuntime().catch((err) => {
    logger.error({ err }, 'Failed to start Gantry');
    process.exit(1);
  });
}
