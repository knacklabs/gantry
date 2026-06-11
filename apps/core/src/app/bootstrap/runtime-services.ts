import {
  DEFAULT_TRIGGER,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
  getCredentialBrokerRuntimeConfig,
  getRuntimeSettingsForConfig,
} from '../../config/index.js';
import {
  createAgentToolRuleSettingsMirror,
  type AgentToolRuleSettingsRepositories,
} from '../../config/settings/agent-tool-rule-settings-mirror.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../../shared/message-cursor.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { NewMessage } from '../../domain/types.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { writeGroupsSnapshot } from '../../runtime/agent-spawn.js';
import { startIpcWatcher, type IpcDeps } from '../../runtime/ipc.js';
// prettier-ignore
import { recoverPendingMessages, startMessagePollingLoop } from '../../runtime/message-loop.js';
// prettier-ignore
import { requestSchedulerSync, startSchedulerLoop } from '../../jobs/scheduler.js';
import { registerWorkerInstance } from '../../jobs/worker-identity.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  makeThreadQueueKey,
  parseThreadQueueKey,
} from '../../shared/thread-queue-key.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
import type { WorkerCoordinationRepository } from '../../domain/ports/worker-coordination.js';
import type {
  LiveTurnCoordinationRepository,
  LiveTurnScope,
} from '../../domain/ports/live-turns.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  OutboundDeliveryRepository,
  PermissionRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type { SessionMemoryCollector } from '../../domain/ports/session-memory-collector.js';
import type { SkillArtifactStore } from '../../domain/ports/skill-artifact-store.js';
import type { RemoteMcpDnsValidationCache } from '../../application/mcp/mcp-server-policy.js';
import { ChannelWiring } from './channel-wiring.js';
import { collectRuntimeSessionMemory } from './runtime-app.js';
import type { RuntimeApp, RuntimeAppRepository } from './runtime-app.js';
import { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import {
  getPartialMessageDeliveryMetadata,
  isPartialMessageDeliveryError,
} from '../../domain/messages/partial-delivery.js';
import { isAmbiguousDurableDeliveryError } from '../../domain/messages/durable-delivery.js';
import { startOutboundDeliveryRecoveryLoop } from '../../jobs/outbound-delivery-recovery.js';
// prettier-ignore
import {
  closeBrowser,
  ensureBrowserReady,
  getBrowserStatus,
} from '../../runtime/browser-capability.js';
import type { OutboundDeliveryProfile } from '../../domain/outbound-delivery/planner.js';
import {
  LIVE_SEND_PROFILE_ID,
  RETRY_TAIL_PROFILE_ID,
  canonicalThreadIdFor,
  normalizeDestinationHintAgainstCanonical,
  resolveDurableOutboundTarget,
  sanitizeRetryTailForCanonicalDestination,
  sanitizeRetryTailProviderPayloadDestinationMetadata,
} from './runtime-services-destination-hints.js';
import { splitLiveSendProfileText } from './runtime-services-live-send-segmentation.js';
import { createDurableOutboundAttempt } from './runtime-services-durable-outbound-attempt.js';
import { handleActiveNewSessionCommand } from './runtime-services-active-new.js';
import { nowIso, nowMs as currentTimeMs } from '../../shared/time/datetime.js';
import { LiveTurnAuthority } from '../../runtime/live-turn-authority.js';
import {
  runLiveTurnRecoveryTick,
  startLiveTurnRecoveryLoop,
  type LiveTurnRecoveryLoop,
} from '../../runtime/live-turn-recovery.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';
import { configurePendingInteractionPermissionPersistence } from '../../application/interactions/pending-interaction-durability.js';
import {
  liveTurnScopeForQueue,
  routeScopeActiveLiveTurnAdmissionFromCursor,
} from './live-turn-host.js';
import { markPendingContinuationCommandsApplied } from './live-turn-continuation.js';
type RuntimeBootstrapRepository = RuntimeAppRepository & RuntimeJobRepository;
interface Deps {
  startSchedulerLoop: typeof startSchedulerLoop;
  startIpcWatcher: typeof startIpcWatcher;
  writeGroupsSnapshot: typeof writeGroupsSnapshot;
  opsRepository: RuntimeBootstrapRepository;
  recoverPendingMessages: typeof recoverPendingMessages;
  startMessagePollingLoop: typeof startMessagePollingLoop;
  logger: Pick<typeof logger, 'info' | 'warn' | 'fatal'>;
  mcpHostnameLookup?: HostnameLookup;
  collectSessionMemory: SessionMemoryCollector;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getSkillRepository?: () => SkillCatalogRepository | undefined;
  getMcpServerRepository?: () => McpServerRepository | undefined;
  getCapabilitySecretRepository?: () => CapabilitySecretRepository | undefined;
  runApprovedCommand?: IpcDeps['runApprovedCommand'];
  getMcpDnsValidationCache?: () => RemoteMcpDnsValidationCache | undefined;
  getSkillArtifactStore?: () => SkillArtifactStore | undefined;
  getToolRepository: () => ToolCatalogRepository;
  getPermissionRepository?: () => PermissionRepository;
  settingsRepositories?: AgentToolRuleSettingsRepositories;
  getOutboundDeliveryRepository?: () => OutboundDeliveryRepository | undefined;
  getWorkerCoordinationRepository?: () =>
    | WorkerCoordinationRepository
    | undefined;
  getLiveTurnRepository?: () => LiveTurnCoordinationRepository | undefined;
  startOutboundDeliveryRecoveryLoop: typeof startOutboundDeliveryRecoveryLoop;
  callBrowserTool: IpcDeps['callBrowserTool'];
  publishRuntimeEvent: IpcDeps['publishRuntimeEvent'];
  publishBrowserJobActivity: IpcDeps['publishBrowserJobActivity'];
  closeBrowserToolBackends: IpcDeps['closeBrowserToolBackends'];
  executionAdapter?: RuntimeApp['executionAdapter'];
  executionAdapters?: RuntimeApp['executionAdapters'];
  runnerSandboxProvider: RuntimeApp['runnerSandboxProvider'];
  exit: (code: number) => never;
}
type RuntimeServicesDefaults = Omit<
  Deps,
  | 'opsRepository'
  | 'getToolRepository'
  | 'getPermissionRepository'
  | 'getWorkerCoordinationRepository'
  | 'getLiveTurnRepository'
  | 'runnerSandboxProvider'
>;
export type RuntimeServicesOptions = {
  app: RuntimeApp;
  channelWiring: ChannelWiring;
  liveTurnsEnabled?: boolean;
};
function makeDefaultDeps(): RuntimeServicesDefaults {
  return {
    startSchedulerLoop,
    startIpcWatcher,
    writeGroupsSnapshot,
    recoverPendingMessages,
    startMessagePollingLoop,
    logger,
    collectSessionMemory: collectRuntimeSessionMemory,
    startOutboundDeliveryRecoveryLoop,
    callBrowserTool: undefined,
    publishRuntimeEvent: undefined,
    publishBrowserJobActivity: undefined,
    closeBrowserToolBackends: undefined,
    exit: (code: number) => process.exit(code),
  };
}
function createGroupSnapshotSync(app: RuntimeApp, deps: Deps): () => void {
  let syncInFlight: Promise<void> | undefined;
  let syncDirty = false;
  const runSync = async () => {
    do {
      syncDirty = false;
      const [conversationRoutes, availableGroups] = [
        app.getConversationRoutes(),
        await app.getAvailableGroups(),
      ];
      const registeredJids = new Set(Object.keys(conversationRoutes));
      await Promise.all(
        Object.values(conversationRoutes).map((group) =>
          deps.writeGroupsSnapshot(
            group.folder,
            availableGroups,
            registeredJids,
          ),
        ),
      );
    } while (syncDirty);
  };
  return () => {
    if (syncInFlight) {
      syncDirty = true;
      return;
    }
    syncInFlight = runSync()
      .catch((err) =>
        deps.logger.warn({ err }, 'Failed to write group snapshots'),
      )
      .finally(() => {
        syncInFlight = undefined;
      });
  };
}
let activeLiveTurnRecoveryLoop: LiveTurnRecoveryLoop | undefined;
let activeLiveTurnAuthority: LiveTurnAuthority | undefined;
export function stopLiveTurnRecoveryLoop(): void {
  activeLiveTurnRecoveryLoop?.stop();
  activeLiveTurnRecoveryLoop = undefined;
}
export function beginDrainingLiveTurnAdmission(): void {
  activeLiveTurnAuthority?.beginDraining();
}
export async function shutdownLiveTurnAuthority(): Promise<void> {
  const authority = activeLiveTurnAuthority;
  activeLiveTurnAuthority = undefined;
  await authority?.shutdown();
}
export async function startRuntimeServices(
  options: RuntimeServicesOptions,
  deps: Partial<RuntimeServicesDefaults> &
    Pick<Deps, 'opsRepository' | 'getToolRepository'> &
    Partial<
      Pick<
        Deps,
        | 'getPermissionRepository'
        | 'getWorkerCoordinationRepository'
        | 'getLiveTurnRepository'
      >
    >,
): Promise<void> {
  const { app, channelWiring } = options;
  const liveTurnsEnabled = options.liveTurnsEnabled ?? true;
  const resolved: Deps = {
    ...makeDefaultDeps(),
    ...deps,
    runnerSandboxProvider: app.runnerSandboxProvider,
  };
  const workerCoordination = resolved.getWorkerCoordinationRepository?.();
  const liveTurns = resolved.getLiveTurnRepository?.();
  const liveTurnLeaseDeps =
    liveTurnsEnabled && workerCoordination && liveTurns
      ? {
          liveTurns,
          coordination: workerCoordination,
          workerInstanceId: await registerWorkerInstance(workerCoordination, {
            warn: (context, message) => resolved.logger.warn(context, message),
          }),
        }
      : undefined;
  const liveTurnAuthority = liveTurnLeaseDeps
    ? new LiveTurnAuthority({
        leaseDeps: liveTurnLeaseDeps,
        slotCapacity: () => app.queue.getPolicy().maxMessageRuns,
        warn: (context, message) => resolved.logger.warn(context, message),
      })
    : undefined;
  activeLiveTurnAuthority = liveTurnAuthority;
  if (liveTurnsEnabled && !liveTurnAuthority) {
    resolved.logger.warn(
      'Live-turn admission is enabled, but durable live-turn repositories are unavailable; falling back to local queue admission',
    );
  }
  const syncGroupSnapshots = createGroupSnapshotSync(app, resolved);
  const onSchedulerChanged = (jobId?: string) => requestSchedulerSync(jobId);
  const startScheduler = () =>
    resolved.startSchedulerLoop({
      conversationRoutes: () => app.getConversationRoutes(),
      queue: app.queue,
      onProcess: (groupJid, proc, runHandle, workspaceFolder, stopAliasJids) =>
        app.queue.registerProcess(
          groupJid,
          proc,
          runHandle,
          workspaceFolder,
          stopAliasJids,
        ),
      sendMessage: (jid, rawText, options) =>
        channelWiring.sendMessage(jid, rawText, {
          durability: 'required',
          throwOnMissing: true,
          ...(options?.threadId
            ? { messageOptions: { threadId: options.threadId } }
            : {}),
        }),
      sendStreamingChunk: channelWiring.sendStreamingChunk,
      resetStreaming: channelWiring.resetStreaming,
      onSchedulerChanged,
      opsRepository: resolved.opsRepository,
      collectSessionMemory: resolved.collectSessionMemory,
      getCredentialBroker:
        resolved.getCredentialBroker ??
        (typeof app.getCredentialBroker === 'function'
          ? () => app.getCredentialBroker()
          : undefined),
      getSkillRepository: resolved.getSkillRepository,
      getMcpServerRepository: resolved.getMcpServerRepository,
      getCapabilitySecretRepository: resolved.getCapabilitySecretRepository,
      getMcpHostnameLookup: () => resolved.mcpHostnameLookup,
      getMcpDnsValidationCache: resolved.getMcpDnsValidationCache,
      getSkillArtifactStore: resolved.getSkillArtifactStore,
      getToolRepository: resolved.getToolRepository,
      getBrowserStatus,
      openBrowserSession: (profileName) => ensureBrowserReady({ profileName }),
      executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
      executionAdapters: resolved.executionAdapters ?? app.executionAdapters,
      runnerSandboxProvider:
        resolved.runnerSandboxProvider ?? app.runnerSandboxProvider,
      closeBrowserSession: closeBrowser,
      closeBrowserToolBackends: resolved.closeBrowserToolBackends,
    });
  const rejectNonLiveInteraction = (kind: 'permission' | 'question'): never => {
    resolved.logger.warn(
      { kind },
      'Rejecting interaction IPC on a worker without live-turn callbacks',
    );
    throw new Error(
      'This worker cannot receive provider interaction callbacks. Retry on a live-turn worker.',
    );
  };
  const mirrorAgentToolRulesToSettings = createAgentToolRuleSettingsMirror({
    opsRepository: resolved.opsRepository,
    repositories: resolved.settingsRepositories,
    reloadRuntimeState: () => app.loadState(),
  });
  configurePendingInteractionPermissionPersistence({
    opsRepository: resolved.opsRepository,
    getToolRepository: resolved.getToolRepository,
    getPermissionRepository: resolved.getPermissionRepository,
    mirrorAgentToolRulesToSettings,
    onSchedulerChanged,
    getSkillRepository: resolved.getSkillRepository,
    getMcpServerRepository: resolved.getMcpServerRepository,
    getCapabilitySecretRepository: resolved.getCapabilitySecretRepository,
    getCredentialBroker: app.getCredentialBroker,
    getBrowserStatus,
    publishRuntimeEvent: resolved.publishRuntimeEvent,
  });
  resolved.startIpcWatcher({
    sendMessage: (jid, text, options) =>
      channelWiring.sendMessage(jid, text, {
        durability: 'required',
        throwOnMissing: true,
        ...(options?.threadId
          ? { messageOptions: { threadId: options.threadId } }
          : {}),
      }),
    conversationRoutes: () => app.getConversationRoutes(),
    registerGroup: app.registerGroup,
    syncGroups: (force: boolean) => channelWiring.syncGroups(force),
    getAvailableGroups: app.getAvailableGroups,
    writeGroupsSnapshot: (folder, availableGroups, registeredJids) =>
      resolved.writeGroupsSnapshot(folder, availableGroups, registeredJids),
    onSchedulerChanged,
    opsRepository: resolved.opsRepository,
    getToolRepository: resolved.getToolRepository,
    getMcpServerRepository: resolved.getMcpServerRepository,
    getCapabilitySecretRepository: resolved.getCapabilitySecretRepository,
    runApprovedCommand: resolved.runApprovedCommand,
    getPermissionRepository: resolved.getPermissionRepository,
    publishRuntimeEvent: resolved.publishRuntimeEvent,
    mirrorAgentToolRulesToSettings,
    reloadRuntimeState: () => app.loadState(),
    getCredentialBroker: app.getCredentialBroker,
    getCredentialBrokerProfile: () => getCredentialBrokerRuntimeConfig().mode,
    callBrowserTool: resolved.callBrowserTool,
    publishBrowserJobActivity: resolved.publishBrowserJobActivity,
    getBrowserStatus,
    closeBrowserToolBackends: resolved.closeBrowserToolBackends,
    getBrowserUsageSettings: () => getRuntimeSettingsForConfig().browser.usage,
    requestPermissionApproval: (request) =>
      liveTurnsEnabled
        ? channelWiring.requestPermissionApproval(request)
        : Promise.reject(rejectNonLiveInteraction('permission')),
    requestUserAnswer: (request) =>
      liveTurnsEnabled
        ? channelWiring.requestUserAnswer(request)
        : Promise.reject(rejectNonLiveInteraction('question')),
    mcpHostnameLookup: resolved.mcpHostnameLookup,
  });
  syncGroupSnapshots();
  app.queue.setLiveTurnRunnerRegistrar(
    liveTurnAuthority
      ? (queueJid, hooks, routing) =>
          liveTurnAuthority.registerLocalRunner(queueJid, hooks, routing)
      : null,
  );
  app.queue.setProcessMessagesFn(async (queueJid) => {
    if (!liveTurnAuthority) {
      return app.processGroupMessages(queueJid, { queued: true });
    }
    let liveRunId = liveTurnAuthority.ownedRunId(queueJid) ?? undefined;
    let liveRunFence = liveTurnAuthority.ownedFence(queueJid);
    if (!liveTurnAuthority.ownsQueue(queueJid)) {
      const { chatJid, threadId } = parseThreadQueueKey(queueJid);
      const route = app.getConversationRoutes()[chatJid];
      if (!route) return false;
      const executionProviderId = resolveRuntimeExecutionProviderId(
        resolved.executionAdapter ?? app.executionAdapter,
      );
      const turnContext = await resolved.opsRepository.getAgentTurnContext?.({
        agentFolder: route.folder,
        executionProviderId,
        conversationJid: chatJid,
        threadId: threadId ?? null,
        conversationKind: route.conversationKind,
        hydrateMemory: false,
      });
      if (!turnContext?.agentSessionId) return false;
      liveRunId = await resolved.opsRepository.createSessionAgentRun?.({
        agentSessionId: turnContext.agentSessionId,
        executionProviderId,
        providerSessionId: turnContext.providerSessionId,
        cause: 'message',
      });
      if (!liveRunId) return false;
      const scope: LiveTurnScope = {
        appId: turnContext.appId,
        agentSessionId: turnContext.agentSessionId,
        conversationId: chatJid,
        threadId: threadId ?? null,
      };
      const replayCursor = await app.getOrRecoverCursor(queueJid);
      const admission = await liveTurnAuthority.admit({
        queueJid,
        scope,
        turnId: `live-turn:${randomUUID()}`,
        runId: liveRunId,
        pendingMessage: {
          kind: 'message_cursor',
          queueJid,
          cursorBefore: replayCursor,
        },
      });
      if (admission.outcome !== 'claimed') {
        if (admission.outcome === 'scope_active') {
          return routeScopeActiveLiveTurnAdmissionFromCursor({
            scope,
            queueJid,
            liveRunId,
            chatJid,
            threadId: threadId ?? null,
            replayCursor,
            maxMessagesPerPrompt: MAX_MESSAGES_PER_PROMPT,
            timezone: TIMEZONE,
            getMessagesSince: resolved.opsRepository.getMessagesSince,
            setAgentCursor: app.setAgentCursor,
            saveState: app.saveState,
            routeMessage:
              liveTurnAuthority.routeMessage.bind(liveTurnAuthority),
            completeSessionAgentRun:
              resolved.opsRepository.completeSessionAgentRun,
          });
        }
        await resolved.opsRepository.completeSessionAgentRun?.({
          runId: liveRunId,
          status:
            admission.outcome === 'lease_unavailable' ? 'failed' : 'canceled',
          errorSummary: `Live-turn admission did not claim the run: ${admission.outcome}`,
        });
        return false;
      }
      liveRunFence = admission.fence;
    }
    try {
      let liveRunResult: 'success' | 'error' | 'stopped' | null = null;
      const success = await app.processGroupMessages(queueJid, {
        queued: true,
        existingRunId: liveRunId,
        ...(liveRunFence
          ? {
              existingRunLeaseToken: liveRunFence.leaseToken,
              existingRunLeaseWorkerInstanceId: liveRunFence.workerInstanceId,
              existingRunLeaseFencingVersion: liveRunFence.fencingVersion,
            }
          : {}),
        onRunResult: (result) => {
          liveRunResult = result;
        },
      });
      const terminalSuccess = success && liveRunResult !== 'stopped';
      const finalized = await liveTurnAuthority.finalize(
        queueJid,
        terminalSuccess ? 'completed' : 'failed',
        {
          status: terminalSuccess ? 'completed' : 'failed',
          ...(terminalSuccess
            ? { resultSummary: 'Live turn completed.' }
            : {
                errorSummary:
                  liveRunResult === 'stopped'
                    ? 'Live turn stopped by request.'
                    : 'Live turn failed.',
              }),
        },
      );
      return success && finalized;
    } catch (err) {
      const finalized = await liveTurnAuthority
        .finalize(queueJid, 'failed', {
          status: 'failed',
          errorSummary: 'Live turn failed during message processing.',
        })
        .catch((finalizeErr) => {
          resolved.logger.warn(
            { err: finalizeErr, queueJid },
            'Failed to finalize live turn after message processing error',
          );
          return false;
        });
      void finalized;
      throw err;
    }
  });
  const liveMessageQueue = {
    sendMessage: async (
      queueJid: string,
      text: string,
      options?: {
        threadId?: string | null;
        senderUserIds?: readonly string[] | null;
        idempotencyKey?: string;
        cursorAfter?: string;
      },
    ): Promise<boolean> => {
      if (!liveTurnAuthority)
        return app.queue.sendMessage(queueJid, text, options);
      const scope = await liveTurnScopeForQueue({
        app,
        opsRepository: resolved.opsRepository,
        executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
        queueJid,
      });
      if (!scope) return false;
      return (
        (await liveTurnAuthority.routeMessage({
          scope,
          queueJid,
          text,
          idempotencyKey:
            options?.idempotencyKey ?? `continuation:${randomUUID()}`,
          senderUserIds: options?.senderUserIds,
          cursorAfter: options?.cursorAfter,
        })) === 'queued_to_owner'
      );
    },
    enqueueMessageCheck: (queueJid: string): void => {
      app.queue.enqueueMessageCheck(queueJid);
    },
    closeStdin: async (queueJid: string): Promise<void> => {
      if (!liveTurnAuthority) {
        app.queue.closeStdin(queueJid);
        return;
      }
      const scope = await liveTurnScopeForQueue({
        app,
        opsRepository: resolved.opsRepository,
        executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
        queueJid,
      });
      const routed =
        scope &&
        (await liveTurnAuthority.routeCloseStdin({
          scope,
          queueJid,
          idempotencyKey: `close:${randomUUID()}`,
        }));
      if (!routed) app.queue.closeStdin(queueJid);
    },
    stopGroup: async (queueJid: string): Promise<boolean> => {
      if (app.queue.stopGroup(queueJid)) return true;
      if (!liveTurnAuthority) return false;
      const scope = await liveTurnScopeForQueue({
        app,
        opsRepository: resolved.opsRepository,
        executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
        queueJid,
      });
      const routed = await liveTurnAuthority.routeStop({
        ...(scope ? { scope } : {}),
        aliasJid: queueJid,
        queueJid,
        idempotencyKey: `stop:${randomUUID()}`,
        requestedBy: 'runtime-control',
      });
      return routed;
    },
  };
  const handleActiveControlCommand = async ({
    chatJid,
    queueJid,
    group,
    command,
    message,
  }: {
    chatJid: string;
    queueJid: string;
    group: { folder: string; conversationKind?: 'dm' | 'channel' };
    command: { kind: string };
    message: NewMessage;
  }): Promise<boolean> => {
    if (
      command.kind !== 'stop' &&
      command.kind !== 'new' &&
      command.kind !== 'compact'
    ) {
      return false;
    }
    if (
      command.kind !== 'compact' &&
      !app.queue.isGroupActive(queueJid) &&
      !liveTurnAuthority?.ownsQueue(queueJid)
    ) {
      return false;
    }
    const threadId =
      typeof message.thread_id === 'string' && message.thread_id.trim()
        ? message.thread_id.trim()
        : undefined;
    if (command.kind === 'compact') {
      const sent = await liveMessageQueue.sendMessage(queueJid, '/compact', {
        threadId,
        senderUserIds: message.sender ? [message.sender] : [],
        idempotencyKey: `compact:${message.id}`,
      });
      if (!sent) return false;
      app.setAgentCursor(
        makeThreadQueueKey(chatJid, threadId),
        encodeGroupMessageCursor(toGroupMessageCursor(message)),
      );
      await app.saveState();
      await channelWiring.sendMessage(chatJid, 'Compacting current session.', {
        durability: 'required',
        ...(threadId ? { messageOptions: { threadId } } : {}),
      });
      return true;
    }
    if (command.kind === 'new') {
      return handleActiveNewSessionCommand({
        app,
        channelWiring,
        opsRepository: resolved.opsRepository,
        collectSessionMemory: resolved.collectSessionMemory,
        logger: resolved.logger,
        group,
        executionAdapter: app.executionAdapter,
        chatJid,
        queueJid,
        threadId,
        message,
      });
    }
    const stopped = await liveMessageQueue.stopGroup(queueJid);
    if (!stopped) {
      return false;
    }
    app.setAgentCursor(
      makeThreadQueueKey(chatJid, threadId),
      encodeGroupMessageCursor(toGroupMessageCursor(message)),
    );
    await app.saveState();
    await channelWiring.sendMessage(
      chatJid,
      command.kind === 'stop'
        ? 'Stopping current run.'
        : 'Started a fresh session.',
      {
        durability: 'required',
        ...(threadId ? { messageOptions: { threadId } } : {}),
      },
    );

    return true;
  };
  if (liveTurnsEnabled) {
    void Promise.resolve(
      resolved.recoverPendingMessages({
        getConversationRoutes: () => app.getConversationRoutes(),
        getLastTimestamp: () => app.getLastTimestamp(),
        setLastTimestamp: (timestamp) => {
          app.setLastTimestamp(timestamp);
        },
        getOrRecoverCursor: app.getOrRecoverCursor,
        setAgentCursor: (chatJid, timestamp) => {
          app.setAgentCursor(chatJid, timestamp);
        },
        saveState: app.saveState,
        hasChannel: (chatJid) => channelWiring.hasChannel(chatJid),
        setTyping: (chatJid, isTyping) =>
          channelWiring.setTyping(chatJid, isTyping),
        sendProgressUpdate: (chatJid, text, options) =>
          channelWiring.sendProgressUpdate(chatJid, text, options),
        queue: liveMessageQueue,
        handleActiveControlCommand,
        opsRepository: resolved.opsRepository,
      }),
    ).catch((err) =>
      resolved.logger.warn({ err }, 'Pending message recovery failed'),
    );
  } else {
    resolved.logger.info(
      'Live-turn admission disabled; skipping pending message recovery',
    );
  }

  const outboundDeliveryRepository = resolved.getOutboundDeliveryRepository?.();
  if (outboundDeliveryRepository) {
    const liveSendProfile: OutboundDeliveryProfile = {
      profileId: LIVE_SEND_PROFILE_ID,
      plan: (input) => {
        const segments = splitLiveSendProfileText(input.text);
        return {
          parts: segments.map((segment) => ({
            canonicalText: segment,
          })),
          canonicalFinalText: input.text,
        };
      },
    };
    const retryTailProfile: OutboundDeliveryProfile = {
      profileId: RETRY_TAIL_PROFILE_ID,
      plan: (input) => {
        const providerPayload =
          input.metadata &&
          typeof input.metadata === 'object' &&
          'providerPayload' in input.metadata
            ? (input.metadata.providerPayload as unknown)
            : undefined;
        return {
          parts: [
            {
              canonicalText: input.text,
              providerPayload,
            },
          ],
          canonicalFinalText: input.text,
        };
      },
    };
    const outboundDeliveryService = new OutboundDeliveryService({
      repository: outboundDeliveryRepository,
      profiles: {
        resolve: (profileId) =>
          profileId === RETRY_TAIL_PROFILE_ID
            ? retryTailProfile
            : profileId === LIVE_SEND_PROFILE_ID
              ? liveSendProfile
              : undefined,
      },
      now: () => nowIso(),
      createId: () => randomUUID(),
      hashSha256Hex: (value: string) =>
        createHash('sha256').update(value, 'utf8').digest('hex'),
    });
    channelWiring.setDurableOutboundAttemptFactory(async (input) => {
      const target = resolveDurableOutboundTarget({
        defaultAppId: input.appId,
        jid: input.chatJid,
      });
      const started = await outboundDeliveryService.enqueue({
        appId: target.appId as never,
        conversationId: target.conversationId as never,
        threadId: canonicalThreadIdFor({
          jid: input.chatJid,
          threadId: input.threadId,
        }) as never,
        profileId: LIVE_SEND_PROFILE_ID,
        idempotencyKey: `live-send:${input.sourceMessageId}`,
        text: input.canonicalText,
        metadata: {
          sourceMessageId: input.sourceMessageId,
          sourceProvider: input.provider,
          destinationJid: input.chatJid,
          destinationThreadId: input.threadId,
        },
        initialClaim: {
          claimToken: `claim:live-send:${input.sourceMessageId}`,
          claimExpiresAt: new Date(currentTimeMs() + 60_000).toISOString(),
        },
      });
      const claimedItems = started.claimedItems;
      if (!started.created || !claimedItems || claimedItems.length === 0) {
        throw new Error(
          `Durable outbound immediate send claim was not created for ${input.sourceMessageId}.`,
        );
      }
      return createDurableOutboundAttempt({
        outboundDeliveryService,
        deliveryId: started.delivery.id,
        claimedItems,
        sourceMessageId: input.sourceMessageId,
      });
    });
    channelWiring.setRetryTailRecoveryEnqueue(async (input) => {
      const target = resolveDurableOutboundTarget({
        defaultAppId: input.appId,
        jid: input.chatJid,
      });
      const sanitizedRetryTail = sanitizeRetryTailForCanonicalDestination(
        input.retryTail,
        input.chatJid,
      );
      if (!sanitizedRetryTail) return;
      const retryTailFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            canonicalText: sanitizedRetryTail.canonicalText,
            providerPayload: sanitizedRetryTail.providerPayload ?? null,
          }),
          'utf8',
        )
        .digest('hex')
        .slice(0, 24);
      await outboundDeliveryService.enqueue({
        appId: target.appId as never,
        conversationId: target.conversationId as never,
        threadId: canonicalThreadIdFor({
          jid: input.chatJid,
          threadId: input.threadId,
        }) as never,
        profileId: RETRY_TAIL_PROFILE_ID,
        idempotencyKey: `retry-tail:${input.sourceMessageId}:${retryTailFingerprint}`,
        text: sanitizedRetryTail.canonicalText,
        metadata: {
          providerPayload: sanitizedRetryTail.providerPayload,
          sourceMessageId: input.sourceMessageId,
          sourceProvider: input.provider,
          destinationJid: input.chatJid,
          destinationThreadId: input.threadId,
        },
      });
    });
    resolved.startOutboundDeliveryRecoveryLoop({
      service: outboundDeliveryService,
      claimerId: `runtime-recovery:${process.pid}`,
      batchLimit: 25,
      maxBatches: 5,
      intervalMs: 5_000,
      leaseMs: 20_000,
      dispatch: async (claimed) => {
        const destination = await outboundDeliveryService.resolveDestination({
          appId: claimed.delivery.appId,
          conversationId: claimed.delivery.conversationId,
          threadId: claimed.delivery.threadId,
        });
        if (!destination) {
          return {
            status: 'failed',
            error:
              'Outbound delivery canonical destination/thread could not be resolved from app-owned conversation metadata.',
          } as const;
        }
        const destinationJid = destination.conversationJid;
        const destinationThreadId = destination.threadId;
        const destinationDescriptor =
          channelWiring.describeDestinationJid(destinationJid);
        if (!destinationDescriptor.providerId) {
          return {
            status: 'failed',
            error:
              'Outbound delivery canonical destination resolves to an unknown provider JID prefix.',
          } as const;
        }
        if (
          destinationDescriptor.providerId !== String(destination.providerId)
        ) {
          return {
            status: 'failed',
            error:
              'Outbound delivery canonical destination provider does not match resolved conversation provider connection.',
          } as const;
        }
        const isCrossAppClaim =
          claimed.delivery.appId !== destinationDescriptor.runtimeAppId;
        if (isCrossAppClaim && destinationDescriptor.internal !== true) {
          return {
            status: 'partially_delivered',
            error: `Outbound delivery recovery quarantined cross-app external destination ${destinationJid} for app ${String(claimed.delivery.appId)} (providerConnectionId ${String(destination.providerConnectionId)}); runtime adapter credentials are scoped to app ${String(destinationDescriptor.runtimeAppId)}.`,
          } as const;
        }
        const payload =
          claimed.item.providerPayload &&
          typeof claimed.item.providerPayload === 'object'
            ? sanitizeRetryTailProviderPayloadDestinationMetadata(
                claimed.item.providerPayload,
                destinationJid,
              )
            : undefined;
        const rawDestinationHint =
          payload?.conversationJid ??
          payload?.chatJid ??
          payload?.jid ??
          payload?.conversationId ??
          (destinationJid.startsWith('sl:') ? payload?.channelId : undefined) ??
          (destinationJid.startsWith('tg:') ? payload?.chatId : undefined);
        const { providerJid: destinationHint, malformedCanonicalHint } =
          normalizeDestinationHintAgainstCanonical(
            rawDestinationHint,
            destinationJid,
          );
        if (malformedCanonicalHint) {
          return {
            status: 'failed',
            error:
              'Outbound delivery provider destination hint has malformed canonical conversationId.',
          } as const;
        }
        const threadHint = payload?.threadId;
        if (
          typeof destinationHint === 'string' &&
          destinationHint.trim() &&
          destinationHint.trim() !== destinationJid
        ) {
          return {
            status: 'failed',
            error:
              'Outbound delivery provider destination hint conflicts with canonical conversationId.',
          } as const;
        }
        if (
          typeof threadHint === 'string' &&
          threadHint.trim() &&
          threadHint.trim() !== (destinationThreadId ?? '')
        ) {
          return {
            status: 'failed',
            error:
              'Outbound delivery provider thread hint conflicts with canonical threadId.',
          } as const;
        }
        if (!channelWiring.hasChannel(destinationJid)) {
          return {
            status: 'failed',
            error:
              'Outbound delivery channel for canonical destination is unavailable.',
          } as const;
        }
        const recoveryPermit = channelWiring.createRecoveryDispatchPermit({
          deliveryId: claimed.delivery.id,
          itemId: claimed.item.id,
          destinationJid,
          canonicalText: claimed.item.canonicalText,
          ...(destinationThreadId ? { threadId: destinationThreadId } : {}),
        });
        try {
          const deliveryResult = await channelWiring.sendProviderMessage(
            destinationJid,
            claimed.item.canonicalText,
            {
              permit: recoveryPermit,
              throwOnMissing: true,
              ...(destinationThreadId
                ? { messageOptions: { threadId: destinationThreadId } }
                : {}),
            },
          );
          return {
            status: 'sent',
            providerMessageId: deliveryResult?.externalMessageId,
            providerPayload: deliveryResult,
          } as const;
        } catch (err) {
          if (isPartialMessageDeliveryError(err)) {
            const partialMetadata = getPartialMessageDeliveryMetadata(err);
            const retryTail = sanitizeRetryTailForCanonicalDestination(
              partialMetadata.retryTail,
              destinationJid,
            );
            return {
              status: 'partially_delivered',
              error: err.message,
              deliveredParts: partialMetadata.deliveredParts,
              totalParts: partialMetadata.totalParts,
              retryTail,
            } as const;
          }
          if (isAmbiguousDurableDeliveryError(err)) {
            return {
              status: 'partially_delivered',
              error: err.message,
            } as const;
          }
          return {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          } as const;
        }
      },
      receiptIdempotencyKeyForItem: (claimed) =>
        `item:${claimed.item.id}:receipt`,
      warn: (meta, message) => resolved.logger.warn(meta, message),
    });
  }
  await startScheduler();
  resolved.logger.info(`Gantry running (default trigger: ${DEFAULT_TRIGGER})`);
  if (liveTurnAuthority && liveTurnLeaseDeps) {
    activeLiveTurnRecoveryLoop?.stop();
    activeLiveTurnRecoveryLoop = startLiveTurnRecoveryLoop({
      intervalMs: 20_000,
      tick: () =>
        runLiveTurnRecoveryTick({
          deps: liveTurnLeaseDeps,
          slotCapacity: app.queue.getPolicy().maxMessageRuns,
          leaseTtlMs: 60_000,
          unleasedStaleMs: 30_000,
          warn: (context, message) => resolved.logger.warn(context, message),
          resumeRecoveredTurn: async ({ turn, lease }) => {
            const queueJid = makeThreadQueueKey(
              turn.conversationId,
              turn.threadId ?? undefined,
            );
            liveTurnAuthority.adoptRecoveredTurn({
              queueJid,
              turn,
              fence: {
                leaseToken: lease.leaseToken,
                workerInstanceId: lease.workerInstanceId,
                fencingVersion: lease.fencingVersion,
              },
            });
            const pendingMessage =
              turn.pendingMessage &&
              typeof turn.pendingMessage === 'object' &&
              !Array.isArray(turn.pendingMessage)
                ? turn.pendingMessage
                : null;
            const replayQueueJid =
              pendingMessage?.queueJid === queueJid ? queueJid : null;
            const cursorBefore =
              typeof pendingMessage?.cursorBefore === 'string'
                ? pendingMessage.cursorBefore
                : null;
            if (!replayQueueJid || cursorBefore === null) {
              resolved.logger.warn(
                { turnId: turn.id, runId: turn.runId, queueJid },
                'Recovered live turn has no replayable pending message; failing closed',
              );
              await liveTurnAuthority.finalize(queueJid, 'failed', {
                status: 'failed',
                errorSummary:
                  'Recovered live turn had no replayable pending message.',
              });
              return;
            }
            const pendingCommands =
              await liveTurnLeaseDeps.liveTurns.listPendingLiveTurnCommands({
                liveTurnId: turn.id,
                limit: 5000,
              });
            app.setAgentCursor(queueJid, cursorBefore);
            await app.saveState();
            app.queue.enqueueMessageCheck(queueJid);
            await markPendingContinuationCommandsApplied({
              liveTurns: liveTurnLeaseDeps.liveTurns,
              commands: pendingCommands,
              fence: lease,
            });
          },
        }),
      warn: (context, message) => resolved.logger.warn(context, message),
    });
  }
  if (!liveTurnsEnabled) {
    resolved.logger.info(
      'Live-turn admission disabled; skipping message polling loop',
    );
    return;
  }
  resolved
    .startMessagePollingLoop({
      getConversationRoutes: () => app.getConversationRoutes(),
      getLastTimestamp: () => app.getLastTimestamp(),
      setLastTimestamp: (timestamp) => app.setLastTimestamp(timestamp),
      getOrRecoverCursor: app.getOrRecoverCursor,
      setAgentCursor: (chatJid, timestamp) =>
        app.setAgentCursor(chatJid, timestamp),
      saveState: app.saveState,
      hasChannel: (chatJid) => channelWiring.hasChannel(chatJid),
      setTyping: (chatJid, isTyping) =>
        channelWiring.setTyping(chatJid, isTyping),
      sendProgressUpdate: (chatJid, text, options) =>
        channelWiring.sendProgressUpdate(chatJid, text, options),
      queue: liveMessageQueue,
      handleActiveControlCommand,
      opsRepository: resolved.opsRepository,
    })
    .catch((err) => {
      resolved.logger.fatal({ err }, 'Message loop crashed unexpectedly');
      resolved.exit(1);
    });
}
