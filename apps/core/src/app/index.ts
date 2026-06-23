import {
  installGlobalErrorHandlers,
  logger,
} from '../infrastructure/logging/logger.js';
import { createChannelWiring } from './bootstrap/channel-wiring.js';
import { createOutboundOwnershipVerifier } from './bootstrap/outbound-ownership-verifier.js';
import { projectInteraktDefaultAgentRoute } from './bootstrap/channel-persistence-handlers.js';
import {
  collectRuntimeSessionMemory,
  getDefaultRuntimeApp,
} from './bootstrap/runtime-app.js';
import { createReplyTraceWiring } from './bootstrap/reply-trace-wiring.js';
import { startRuntimeServices } from './bootstrap/runtime-services.js';
import { installShutdownHandlers } from './bootstrap/shutdown.js';
import { prewarmWarmPoolRoutes, runStartup } from './bootstrap/startup.js';
import {
  closeRuntimeStorage,
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeSkillArtifactStore,
  getRuntimeStorage,
} from '../adapters/storage/postgres/runtime-store.js';
import { startControlServer } from '../control/server/index.js';
import { stopSchedulerLoop } from '../jobs/scheduler.js';
import { stopOutboundDeliveryRecoveryLoop } from '../jobs/outbound-delivery-recovery.js';
import { publishBrowserJobActivityEvent } from '../jobs/browser-activity-events.js';
import {
  GANTRY_HOME,
  MAX_MESSAGES_PER_PROMPT,
  getRuntimeOwnershipConfig,
  getRuntimeTraceConfig,
  getRuntimeWarmPoolConfig,
} from '../config/index.js';
import { hydrateDynamicRuntimeEnv } from '../config/env/index.js';
import { getBrowserStatus } from '../runtime/browser-capability.js';
import { closeEgressGateways } from '../runtime/egress-gateway.js';
import type { IpcSocketServerHandle } from '../runtime/ipc-socket-server.js';
import { startSettingsReloadWatcher } from '../runtime/settings-reload-watcher.js';
import { startWarmPoolMaintenance } from '../runtime/warm-pool-maintenance.js';
import { startWorkerInventoryHeartbeat } from '../runtime/worker-inventory-heartbeat.js';
import { startMessageTracePayloadRetention } from '../runtime/message-trace-payload-retention.js';
import {
  createIdleSessionSweeper,
  resolveDigestAndShortMemoryWatcherPollIntervalMs,
  startIdleSessionSweepLoop,
} from '../runtime/idle-session-sweep.js';
import { startConversationWorkDispatcher } from '../runtime/conversation-work-dispatcher.js';
import { createConversationWorkClaimGate } from '../runtime/conversation-work-claim-gate.js';
import {
  findPendingMessageWorkCandidates,
  startConversationWorkReconciler,
} from '../runtime/conversation-work-reconciler.js';
import { createOwnerClaimingConversationWorkPublisher } from '../runtime/conversation-work-notification-publisher.js';
import {
  formatRuntimePreflightFailure,
  validateRuntimePreflightWithStorage,
} from '../config/preflight.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import { defaultHostnameLookup } from '../infrastructure/network/hostname-lookup.js';
import { PostgresMessageTraceRepository } from '../adapters/storage/postgres/repositories/message-trace-repository.postgres.js';
import {
  makeThreadQueueKey,
  parseThreadQueueKey,
} from '../shared/thread-queue-key.js';

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
  // Make these dev/test flags settable from $GANTRY_HOME/.env (they are read via
  // process.env in `shared`/`application` layers, which may not import config).
  // Keep them unset/off in production — see the DEV block in .env.
  hydrateDynamicRuntimeEnv([
    'GANTRY_FLOW_LOG',
    'GANTRY_OUTBOUND_DRYRUN',
    'GANTRY_TEST_OPERATOR_PHONE',
    'GANTRY_TEST_CALLER_IDENTITY_PHONE',
    // Developer-only child-runner switch (fails safe to dist when no source
    // tree exists); settable from .env so dev runs don't need a rebuild per
    // runner-side edit.
    'GANTRY_CHILD_RUNNER_FROM_SOURCE',
    // Dev-only: when '1', the per-reply latency trace also persists full
    // request/response + LLM input/output payloads (payloads_json). Timings are
    // always captured; only payload capture is gated. Off in production.
    'GANTRY_TRACE_PAYLOADS',
  ]);
  if (!options.skipPreflight) {
    const validation = await validateRuntimePreflightWithStorage(GANTRY_HOME);
    if (!validation.ok && validation.failure) {
      throw new Error(formatRuntimePreflightFailure(validation.failure));
    }
  }

  // One process-wide reply-trace wiring: a shared RunTraceCollector (MCP
  // capture ↔ persist-time drain) plus a best-effort trace repository.
  const replyTraceWiring = createReplyTraceWiring();
  const instanceId = `runtime:${process.pid}`;
  const ownershipConfig = getRuntimeOwnershipConfig();
  const conversationWorkClaimGate = createConversationWorkClaimGate({
    claimLease: (input) =>
      getRuntimeStorage().conversationOwnerLeases.claimLease(input),
    heartbeatLease: (input) =>
      getRuntimeStorage().conversationOwnerLeases.heartbeatLease(input),
  });
  const app = getDefaultRuntimeApp({
    mcpHostnameLookup: () => mcpHostnameLookup,
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
    replyTrace: replyTraceWiring.port,
    getMessageSendOwnershipToken: async ({ conversationId, threadId }) => {
      const claim =
        await getRuntimeStorage().conversationOwnerLeases.claimLease({
          appId: 'default',
          conversationId,
          threadId,
          ownerInstanceId: instanceId,
          leaseTtlMs: ownershipConfig.leaseTtlMs,
          reason: 'process_group_messages_send',
        });
      if (!claim.acquired) {
        throw new Error(
          `Conversation ownership claim lost before provider send for ${conversationId}.`,
        );
      }
      return {
        appId: claim.lease.appId,
        conversationId: claim.lease.conversationId,
        threadId: claim.lease.threadId,
        ownerInstanceId: claim.lease.ownerInstanceId,
        leaseVersion: claim.lease.leaseVersion,
      };
    },
    claimConversationWork: async ({ conversationId, threadId }) => {
      const claim = await conversationWorkClaimGate.claimLease({
        appId: 'default',
        conversationId,
        threadId,
        ownerInstanceId: instanceId,
        leaseTtlMs: ownershipConfig.leaseTtlMs,
        reason: 'process_group_messages_start',
      });
      return claim.acquired;
    },
    onMessageRunStart: (queueJid) => {
      const parsed = parseThreadQueueKey(queueJid);
      return conversationWorkClaimGate.startTrackedLeaseHeartbeat({
        appId: 'default',
        conversationId: parsed.chatJid,
        threadId: parsed.threadId ?? null,
        ownerInstanceId: instanceId,
        leaseTtlMs: ownershipConfig.leaseTtlMs,
        intervalMs: ownershipConfig.heartbeatIntervalMs,
      });
    },
  });
  const publishConversationWorkNotification =
    createOwnerClaimingConversationWorkPublisher({
      instanceId,
      leaseTtlMs: ownershipConfig.leaseTtlMs,
      claimLease: conversationWorkClaimGate.claimLease,
      notify: (input) =>
        getRuntimeStorage().conversationWorkNotifier.notify(input),
      logger,
    });
  const channelWiring = createChannelWiring(app, {
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
    publishConversationWorkNotification,
    verifyOutboundOwnership: createOutboundOwnershipVerifier({
      verifyLeaseVersion: (input) =>
        getRuntimeStorage().conversationOwnerLeases.verifyLeaseVersion(input),
    }),
  });
  const controlServerRef: {
    current?: {
      close: () => Promise<void>;
    };
  } = {};
  // Populated by startRuntimeServices when this core wins the socket election.
  // Bridged into installShutdownHandlers below to stop the server on shutdown;
  // null-safe when no server was started.
  const socketServerRef: { current?: IpcSocketServerHandle } = {};
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

  const { runtimeSettings } = await runStartup(app);
  const storage = getRuntimeStorage();
  const hasPendingMessageWork = async (input: {
    conversationId: string;
    threadId?: string | null;
  }): Promise<boolean> => {
    const queueKey = makeThreadQueueKey(input.conversationId, input.threadId);
    const cursor = await app.getOrRecoverCursor(queueKey);
    const pending = await storage.ops.getMessagesSince(
      input.conversationId,
      cursor,
      MAX_MESSAGES_PER_PROMPT,
      { threadId: input.threadId ?? null },
    );
    return pending.length > 0;
  };
  const conversationWorkDispatcher = startConversationWorkDispatcher({
    instanceId,
    notifier: storage.conversationWorkNotifier,
    claimLease: conversationWorkClaimGate.claimLease,
    leaseTtlMs: ownershipConfig.leaseTtlMs,
    enqueueMessageCheck: (queueKey) => app.queue.enqueueMessageCheck(queueKey),
    logger,
  });
  const conversationWorkReconciler = startConversationWorkReconciler({
    instanceId,
    leaseTtlMs: ownershipConfig.leaseTtlMs,
    intervalMs: ownershipConfig.reconcilerIntervalMs,
    scanLimit: ownershipConfig.reconcilerLimit,
    findCandidates: async ({ now, limit }) => {
      const pendingMessageCandidates = await findPendingMessageWorkCandidates({
        getConversationRoutes: () => app.getConversationRoutes(),
        getOrRecoverCursor: app.getOrRecoverCursor,
        messageRepository: storage.ops,
        ensureConversationRoute: (conversationId) =>
          projectInteraktDefaultAgentRoute({
            app,
            chatJid: conversationId,
            addedAt: now.toISOString(),
            logger,
          }),
        limit,
      });
      const remainingLimit = limit - pendingMessageCandidates.length;
      if (remainingLimit <= 0) return pendingMessageCandidates;
      const leases =
        await storage.conversationOwnerLeases.findExpiredOrUnownedWork({
          now,
          limit: remainingLimit,
        });
      return [
        ...pendingMessageCandidates,
        ...leases.map((lease) => ({
          appId: lease.appId,
          conversationId: lease.conversationId,
          threadId: lease.threadId,
          reason:
            lease.state === 'draining'
              ? ('draining_owner_lease' as const)
              : ('expired_owner_lease' as const),
        })),
      ];
    },
    claimLease: conversationWorkClaimGate.claimLease,
    hasPendingWork: hasPendingMessageWork,
    enqueueMessageCheck: (queueKey) => app.queue.enqueueMessageCheck(queueKey),
    logger,
  });
  const settingsWatcher = startSettingsReloadWatcher({
    runtimeHome: GANTRY_HOME,
    app,
    ops: storage.ops,
    repositories: storage.repositories,
  });
  const warmPoolMaintenance = startWarmPoolMaintenance({
    warmPool: app.warmPool,
    idleTtlMs: getRuntimeWarmPoolConfig().idleTtlMs,
    logger,
  });
  const workerInventoryHeartbeat = startWorkerInventoryHeartbeat({
    appId: 'default',
    getSnapshot: () => app.getWorkerInventorySnapshot(),
    saveSnapshot: (input) =>
      storage.workerInventorySnapshots.saveSnapshot(input),
    logger,
  });
  const traceConfig = getRuntimeTraceConfig();
  const messageTracePayloadRepository = new PostgresMessageTraceRepository(
    storage.service.db,
    {
      warn: (payload, message) => logger.warn(payload, message),
    },
  );
  const messageTracePayloadRetention = startMessageTracePayloadRetention({
    appId: 'default',
    retentionMs: traceConfig.payloadRetentionMs,
    cleanupIntervalMs: traceConfig.payloadCleanupIntervalMs,
    clearPayloadsOlderThan: (input) =>
      messageTracePayloadRepository.clearPayloadsOlderThan(input),
    logger,
  });
  const digestWatcherPollIntervalMs =
    resolveDigestAndShortMemoryWatcherPollIntervalMs();
  const idleSessionSweepLoop =
    digestWatcherPollIntervalMs === undefined
      ? { close: () => undefined }
      : startIdleSessionSweepLoop({
          runSweep: createIdleSessionSweeper({
            collectSessionMemory: collectRuntimeSessionMemory,
          }),
          intervalMs: digestWatcherPollIntervalMs,
          logger,
        });
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

  installShutdownHandlers({
    queue: app.queue,
    disconnectChannels: channelWiring.disconnectChannels,
    closeControlServer: async () => {
      await controlServerRef.current?.close();
    },
    closeIpcSocketServer: async () => {
      await socketServerRef.current?.stop();
    },
    closeEgressGateways,
    closeStorage: closeRuntimeStorage,
    closeScheduler: stopSchedulerLoop,
    closeOutboundDeliveryRecovery: stopOutboundDeliveryRecoveryLoop,
    closeConversationWorkReconciler: () => {
      conversationWorkClaimGate.close('runtime_shutdown');
      conversationWorkReconciler.close();
      conversationWorkDispatcher.close();
    },
    closeIdleSessionSweepLoop: idleSessionSweepLoop.close,
    closeWorkerInventoryHeartbeat: workerInventoryHeartbeat.close,
    closeMessageTracePayloadRetention: messageTracePayloadRetention.close,
    releaseConversationOwnerLeases: async () => {
      await conversationWorkClaimGate.releaseTrackedLeases({
        releaseLease: (input) =>
          storage.conversationOwnerLeases.releaseLease(input),
        inFlightClaimWaitMs: ownershipConfig.shutdownClaimWaitMs,
      });
    },
    markConversationOwnerLeasesDraining: async () => {
      await storage.conversationOwnerLeases.markDraining({
        ownerInstanceId: instanceId,
        reason: 'runtime_shutdown',
      });
    },
    closeSettingsWatcher: settingsWatcher.close,
    closeWarmPool: app.warmPool
      ? async () => {
          warmPoolMaintenance.close();
          await app.warmPool!.shutdown?.();
        }
      : undefined,
    closeBrowserToolBackends: async () =>
      (await loadBrowserToolModule()).closeBrowserToolBackends(),
  });

  await startRuntimeServices(
    {
      app,
      channelWiring,
      socketServerRef,
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
      claimRecoveredConversationWork: async ({ conversationId, threadId }) => {
        const claim = await conversationWorkClaimGate.claimLease({
          appId: 'default',
          conversationId,
          threadId,
          ownerInstanceId: instanceId,
          leaseTtlMs: ownershipConfig.leaseTtlMs,
          reason: 'recover_pending_messages',
        });
        return claim.acquired;
      },
      claimConversationWork: async ({ conversationId, threadId }) => {
        const claim = await conversationWorkClaimGate.claimLease({
          appId: 'default',
          conversationId,
          threadId,
          ownerInstanceId: instanceId,
          leaseTtlMs: ownershipConfig.leaseTtlMs,
          reason: 'message_loop_accept',
        });
        return claim.acquired;
      },
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
      recordReplyToolCall: replyTraceWiring.recordReplyToolCall,
    },
  );
  await prewarmWarmPoolRoutes(app, runtimeSettings, logger);
  await channelWiring.connectEnabledChannels(runtimeSettings);

  if (!channelWiring.hasConnectedChannels()) {
    logger.warn(
      'No channels connected; runtime will continue without inbound/outbound channel delivery',
    );
  }

  const controlServer = startControlServer({
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
  await controlServer.ready;
  controlServerRef.current = controlServer;
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
