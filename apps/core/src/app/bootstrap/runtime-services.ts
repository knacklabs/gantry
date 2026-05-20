import {
  DEFAULT_TRIGGER,
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
import { createHash, randomUUID } from 'node:crypto';
import { makeThreadQueueKey } from '../../runtime/thread-queue-key.js';
import type { RuntimeJobRepository } from '../../domain/repositories/ops-repo.js';
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
import { closeBrowser, getBrowserStatus } from '../../runtime/browser-capability.js';
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
  startOutboundDeliveryRecoveryLoop: typeof startOutboundDeliveryRecoveryLoop;
  callBrowserTool: IpcDeps['callBrowserTool'];
  publishRuntimeEvent: IpcDeps['publishRuntimeEvent'];
  publishBrowserJobActivity: IpcDeps['publishBrowserJobActivity'];
  closeBrowserToolBackends: IpcDeps['closeBrowserToolBackends'];
  executionAdapter?: RuntimeApp['executionAdapter'];
  exit: (code: number) => never;
}
type RuntimeServicesDefaults = Omit<
  Deps,
  'opsRepository' | 'getToolRepository' | 'getPermissionRepository'
>;
export type RuntimeServicesOptions = {
  app: RuntimeApp;
  channelWiring: ChannelWiring;
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

export async function startRuntimeServices(
  options: RuntimeServicesOptions,
  deps: Partial<RuntimeServicesDefaults> &
    Pick<Deps, 'opsRepository' | 'getToolRepository'> &
    Partial<Pick<Deps, 'getPermissionRepository'>>,
): Promise<void> {
  const resolved: Deps = {
    ...makeDefaultDeps(),
    ...deps,
  };

  const { app, channelWiring } = options;
  const syncGroupSnapshots = createGroupSnapshotSync(app, resolved);

  const onSchedulerChanged = (jobId?: string) => requestSchedulerSync(jobId);
  const startScheduler = () =>
    resolved.startSchedulerLoop({
      conversationRoutes: () => app.getConversationRoutes(),
      queue: app.queue,
      onProcess: (groupJid, proc, runHandle, groupFolder, stopAliasJids) =>
        app.queue.registerProcess(
          groupJid,
          proc,
          runHandle,
          groupFolder,
          stopAliasJids,
        ),
      sendMessage: (jid, rawText, options) =>
        channelWiring.sendMessage(jid, rawText, {
          durability: 'required',
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
      executionAdapter: resolved.executionAdapter ?? app.executionAdapter,
      closeBrowserSession: closeBrowser,
      closeBrowserToolBackends: resolved.closeBrowserToolBackends,
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
    mirrorAgentToolRulesToSettings: createAgentToolRuleSettingsMirror({
      opsRepository: resolved.opsRepository,
      repositories: resolved.settingsRepositories,
      reloadRuntimeState: () => app.loadState(),
    }),
    reloadRuntimeState: () => app.loadState(),
    getCredentialBroker: app.getCredentialBroker,
    getCredentialBrokerProfile: () => getCredentialBrokerRuntimeConfig().mode,
    callBrowserTool: resolved.callBrowserTool,
    publishBrowserJobActivity: resolved.publishBrowserJobActivity,
    getBrowserStatus,
    closeBrowserToolBackends: resolved.closeBrowserToolBackends,
    getBrowserUsageSettings: () => getRuntimeSettingsForConfig().browser.usage,
    requestPermissionApproval: channelWiring.requestPermissionApproval,
    requestUserAnswer: channelWiring.requestUserAnswer,
    mcpHostnameLookup: resolved.mcpHostnameLookup,
  });
  syncGroupSnapshots();
  app.queue.setProcessMessagesFn((chatJid) =>
    app.processGroupMessages(chatJid, { queued: true }),
  );
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
    if (!app.queue.isGroupActive(queueJid)) {
      return false;
    }
    const threadId =
      typeof message.thread_id === 'string' && message.thread_id.trim()
        ? message.thread_id.trim()
        : undefined;

    if (command.kind === 'compact') {
      const sent = app.queue.sendMessage(queueJid, '/compact', { threadId });
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

    const stopped = app.queue.stopGroup(queueJid);
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
      queue: app.queue,
      handleActiveControlCommand,
      opsRepository: resolved.opsRepository,
    }),
  ).catch((err) =>
    resolved.logger.warn({ err }, 'Pending message recovery failed'),
  );

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
        const resolvedProviderIdForComparison =
          destination.providerId === 'control-http' &&
          destinationJid.startsWith('app:')
            ? 'app'
            : String(destination.providerId);
        if (
          destinationDescriptor.providerId !== resolvedProviderIdForComparison
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

  resolved
    .startMessagePollingLoop({
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
      queue: app.queue,
      handleActiveControlCommand,
      opsRepository: resolved.opsRepository,
    })
    .catch((err) => {
      resolved.logger.fatal({ err }, 'Message loop crashed unexpectedly');
      resolved.exit(1);
    });
}
