import {
  installGlobalErrorHandlers,
  logger,
} from '../infrastructure/logging/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { createRuntimeBrainChannelHarvestTap } from '../brain/brain-runtime.js';
import { getDefaultRuntimeApp } from './bootstrap/runtime-app.js';
import {
  startRuntimeServices,
  beginDrainingLiveTurnAdmission,
  shutdownLiveTurnAuthority,
  stopAsyncTaskRecoveryLoop,
  stopLiveTurnRecoveryLoop,
  stopLiveAdmissionLoop,
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
import { startSchedulerLoop, stopSchedulerLoop } from '../jobs/scheduler.js';
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
  validateRuntimePreflight,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';
import { startLiveRecoveryCoordinatorLeaseAcquisition } from './bootstrap/live-recovery-coordinator.js';
import { resolveProcessRole } from './bootstrap/roles/role-resolver.js';
import { roleCapabilities } from './bootstrap/roles/role-capabilities.js';
import { roleReadinessRequirements } from './bootstrap/roles/role-readiness.js';
import { currentWorkerInstanceId } from '../jobs/worker-identity.js';
import { isSchedulerReady } from '../jobs/scheduler.js';
import { getOldestWaitingLiveAdmissionSeconds } from './bootstrap/runtime-services.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import { defaultHostnameLookup } from '../infrastructure/network/hostname-lookup.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
import {
  initializeGantryLangfuseTracingFromEnv,
  shutdownGantryLangfuseTracing,
} from '@cawstudios/agent-gantry';

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
  await initializeGantryLangfuseTracingFromEnv(process.env);
  const mcpHostnameLookup = options.mcpHostnameLookup ?? defaultHostnameLookup;

  // Resolve the deployment-owned process role before preflight. Fleet workers
  // may start from an empty runtime home and must fetch settings_revisions from
  // Postgres before the production sandbox gate can evaluate the real settings.
  const processRole = resolveProcessRole(process.env);
  const shouldDeferPreflightForFleetRole = processRole !== 'all';

  // Thread the role capability struct into every subsystem. Workstation default
  // (env unset) is `all`, which keeps full single-process behaviour; a wrong
  // value already threw above.
  const roleCaps = roleCapabilities(processRole);
  logger.info({ processRole, capabilities: roleCaps }, 'Resolved process role');

  const app = getDefaultRuntimeApp({
    processRole,
    mcpHostnameLookup: () => mcpHostnameLookup,
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
  });
  const channelWiring = createChannelWiring(app, {
    brainHarvestTap: createRuntimeBrainChannelHarvestTap(),
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
    sendMessage: (chatJid, rawText, options) => {
      const runtimeOptions = options as
        | (typeof options & { durability?: 'required' | 'best_effort' })
        | undefined;
      const { durability = 'required', ...messageOptions } =
        runtimeOptions ?? {};
      return channelWiring.sendMessage(chatJid, rawText, {
        durability,
        messageOptions,
      });
    },
    sendAdaptiveCard: (chatJid, card, options) =>
      channelWiring.sendAdaptiveCard(chatJid, card, options),
    sendStreamingChunk: channelWiring.sendStreamingChunk,
    resetStreaming: channelWiring.resetStreaming,
    setTyping: channelWiring.setTyping,
    sendProgressUpdate: channelWiring.sendProgressUpdate,
    renderAgentTodo: channelWiring.renderAgentTodo,
    hydrateConversationContext: channelWiring.hydrateConversationContext,
    isControlApproverAllowed: channelWiring.isControlApproverAllowed,
  });

  let { runtimeSettings } = await runStartup(app, {
    settingsAuthority: shouldDeferPreflightForFleetRole ? 'file' : 'revision',
    validateSettingsImportPreflight: options.skipPreflight
      ? () => ({ ok: true })
      : validateRuntimePreflight,
  });
  const storage = getRuntimeStorage();
  channelWiring.setRuntimeSecrets(
    createRepositoryRuntimeSecretProvider({
      appId: 'default' as AppId,
      repository: storage.repositories.capabilitySecrets,
    }),
  );
  const isFleet =
    getDeploymentMode() === 'fleet' || shouldDeferPreflightForFleetRole;

  // Fleet desired state lives in Postgres (ADR-3). Before runtime services need
  // settings, fetch the latest revision, render it to the runtime home, and
  // reconcile it through the shared import path. No revision yet → settings NOT
  // loaded (red /readyz) + a log naming the seed command. The file watcher is
  // disabled in fleet (explicit CLI import only); workstation is unchanged.
  let fleetSettingsLoaded = true;
  if (isFleet) {
    const prepared = await prepareFleetSettings({
      appId: 'default' as AppId,
      runtimeHome: GANTRY_HOME,
      app,
    });
    fleetSettingsLoaded = prepared.loaded;
    if (prepared.loaded) {
      runtimeSettings = loadRuntimeSettings(GANTRY_HOME);
    }
  }
  if (!options.skipPreflight && fleetSettingsLoaded) {
    const validation = await validateRuntimePreflightWithStorage(GANTRY_HOME);
    if (!validation.ok && validation.failure) {
      throw new Error(formatRuntimePreflightFailure(validation.failure));
    }
  }
  // P2 guard: a fleet worker with no settings revision must not claim
  // scheduled jobs under bundled default settings (/readyz red only protects
  // inbound). Hold the scheduler start; the settings revision listener
  // releases it via onSettingsReady when the first revision is applied.
  let heldSchedulerStart: (() => Promise<void>) | undefined;
  const holdSchedulerUntilSettingsLoaded = isFleet && !fleetSettingsLoaded;
  const settingsWatcher = isFleet
    ? { close: () => {} }
    : startSettingsReloadWatcher({
        runtimeHome: GANTRY_HOME,
        app,
        ops: storage.ops,
        repositories: storage.repositories,
        appId: 'default' as AppId,
        settingsRevisions: storage.repositories.settingsRevisions,
        settingsRevisionPool: storage.service.pool,
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

  const liveRecoveryCoordinatorLeaseManager =
    startLiveRecoveryCoordinatorLeaseAcquisition({
      runtimeSettings,
      leases: { tryAcquire: tryAcquireRuntimeAdvisoryLease },
      liveExecutionEnabled: roleCaps.liveExecution,
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
    closeLiveAdmissionLoop: stopLiveAdmissionLoop,
    closeLiveTurnRecovery: async () => {
      stopLiveTurnRecoveryLoop();
    },
    closeAsyncTaskRecovery: async () => {
      stopAsyncTaskRecoveryLoop();
    },
    closeLiveTurnAuthority: shutdownLiveTurnAuthority,
    closeSettingsWatcher: settingsWatcher.close,
    closeLiveRecoveryCoordinatorLease: async () => {
      await liveRecoveryCoordinatorLeaseManager.stop();
    },
    closeFleetSubsystems: async () => {
      await fleetSubsystems?.stop();
    },
    closeBrowserToolBackends: async () =>
      (await loadBrowserToolModule()).closeBrowserToolBackends(),
    closeLangfuseTracing: shutdownGantryLangfuseTracing,
  });

  // The standby acquirer runs in the background; every live worker polls and
  // admits regardless. This lease only elects the single recovery coordinator;
  // lease transitions (acquired/lost) start and stop the recovery coordinator
  // in-process via the manager handed to startRuntimeServices below.
  try {
    if (!runtimeSettings.runtime.liveTurns.enabled) {
      logger.info(
        'Live recovery coordinator disabled by runtime.live_turns.enabled=false; connecting channels in outbound-only mode',
      );
    }
    if (!roleCaps.providerInbound) {
      logger.info(
        { processRole },
        'Process role has no provider inbound; connecting channels in outbound-only mode',
      );
    }
    await channelWiring.connectEnabledChannels(runtimeSettings, {
      providerInbound: roleCaps.providerInbound,
    });

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
        recoveryCoordinator: liveRecoveryCoordinatorLeaseManager,
        processRole,
        liveExecution: roleCaps.liveExecution,
        jobExecution: roleCaps.jobExecution,
      },
      {
        mcpHostnameLookup,
        opsRepository: storage.ops,
        getToolRepository: () => storage.repositories.tools,
        getSkillRepository: () => storage.repositories.skills,
        getAsyncTaskRepository: () => storage.repositories.asyncTasks,
        getFileArtifactStore: () => storage.fileArtifacts,
        getMcpServerRepository: () => storage.repositories.mcpServers,
        getCapabilitySecretRepository: () =>
          storage.repositories.capabilitySecrets,
        runApprovedCommand: async (input) =>
          (await loadApprovedCommandModule()).runApprovedSandboxCommand(input),
        getSkillArtifactStore: getRuntimeSkillArtifactStore,
        getPermissionRepository: () => storage.repositories.permissions,
        getPermissionPromotionRepository: () =>
          storage.repositories.permissionPromotions,
        settingsRepositories: storage.repositories,
        getOutboundDeliveryRepository: () =>
          storage.repositories.outboundDeliveries,
        getWorkerCoordinationRepository: () =>
          storage.repositories.workerCoordination,
        getLiveTurnRepository: () => storage.repositories.liveTurns,
        getLiveAdmissionWakeupSource: () => storage.liveAdmissionWakeupSource,
        getLiveTurnCommandWakeupSource: () =>
          storage.liveTurnCommandWakeupSource,
        getRuntimeDependencyRepository: () =>
          storage.repositories.runtimeDependencies,
        publishRuntimeEvent: async (event) => {
          await getRuntimeEventExchange().publish(event);
        },
        subscribeRuntimeEvents: (filter) =>
          getRuntimeEventExchange().subscribe(filter),
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
        ...(holdSchedulerUntilSettingsLoaded
          ? {
              startSchedulerLoop: (async (schedulerDeps) => {
                heldSchedulerStart = () => startSchedulerLoop(schedulerDeps);
                logger.warn(
                  'Fleet worker has no settings revision; scheduler job ' +
                    'claiming is held until desired state is seeded ' +
                    '(gantry settings import --file settings.yaml)',
                );
              }) as typeof startSchedulerLoop,
            }
          : {}),
      },
    );

    // Fleet-only worker subsystems start after runtime services register this
    // worker instance: the toolchain bake queue, the capability reconciler, and
    // the settings revision listener (NOTIFY + poll, applying new revisions and
    // holding on reader-version skew). Stopped in the drain sequence. On a
    // first boot with no revision, the bake queue/reconciler are held and the
    // scheduler start above is released by the first applied revision.
    if (isFleet) {
      fleetSubsystems = await startFleetSubsystems({
        app,
        appId: 'default' as AppId,
        runtimeHome: GANTRY_HOME,
        pool: storage.service.pool,
        bakeExecution: roleCaps.bakeExecution,
        capabilityReconciliation: roleCaps.workerRegistration,
        settingsLoaded: fleetSettingsLoaded,
        onSettingsReady: async () => {
          const start = heldSchedulerStart;
          heldSchedulerStart = undefined;
          if (!start) return;
          await start();
          logger.info(
            'First settings revision applied; scheduler job claiming started',
          );
        },
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
      routeProfile: roleCaps.controlApi,
      processRole,
      liveExecution: roleCaps.liveExecution,
      liveTurnsEnabled: runtimeSettings.runtime.liveTurns.enabled,
      // Locked contract: the workstation `all` role keeps the historical
      // readiness check set (no role-specific checks); split roles gate on
      // exactly the subsystems they run.
      roleReadinessRequirements:
        processRole === 'all'
          ? {
              requiresApiAuthConfigured: false,
              requiresWorkerRegistration: false,
              requiresSchedulerClaiming: false,
              requiresLiveCapacitySignal: false,
            }
          : roleReadinessRequirements(processRole),
      currentWorkerInstanceId,
      isSchedulerReady,
      oldestWaitingLiveAdmissionSeconds: getOldestWaitingLiveAdmissionSeconds,
      liveCapacityLimit: () => app.queue.getPolicy().maxMessageRuns,
      sendConversationIngressProjection: async (input) => {
        await channelWiring.sendMessage(input.conversationJid, input.text, {
          durability: 'required',
          throwOnMissing: true,
          messageOptions: input.threadId
            ? {
                threadId: input.threadId,
                providerAccountId: input.providerAccountId,
              }
            : { providerAccountId: input.providerAccountId },
        });
      },
      addMessageReaction: (jid, messageRef, emoji, options) =>
        channelWiring.addReaction(jid, messageRef, emoji, options),
    });
  } catch (err) {
    await liveRecoveryCoordinatorLeaseManager.stop();
    await fleetSubsystems?.stop();
    await shutdownGantryLangfuseTracing();
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
