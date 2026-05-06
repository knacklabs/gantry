import { randomUUID } from 'node:crypto';

import { RuntimeSettings } from '../../config/settings/runtime-settings.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  GroupDiscoverySource,
  MessageDeliveryResult,
  MessageSendOptions,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../../domain/types.js';
import {
  findChannel,
  formatOutboundForChannel,
  stripInternalTagsPreserveWhitespace,
} from '../../messaging/router.js';
import {
  isSenderControlAllowed,
  isSenderAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
  shouldDropMessage,
  shouldLogDenied,
} from '../../platform/sender-allowlist.js';
import {
  asRemoteControlCommand,
  handleRemoteControlCommand,
} from '../../runtime/remote-control-command.js';
import { isPartialMessageDeliveryError } from '../../runtime/partial-delivery.js';
import {
  getRuntimeStorage,
  getRuntimeRepositories,
  tryAcquireRuntimeAdvisoryLease,
} from '../../adapters/storage/postgres/runtime-store.js';
import { ChannelAdapter } from '../../channels/channel-provider.js';
import { EnvRuntimeSecretProvider } from '../../adapters/credentials/env-runtime-secret-provider.js';
import { RuntimeApp } from './runtime-app.js';
import { ConversationAdministrationService } from '../../application/provider-conversations/conversation-administration-service.js';
import { RuntimeSecretConversationMembershipValidator } from '../../channels/conversation-membership-validation.js';
import { AgentDmAccessAdministrationService } from '../../application/agents/agent-dm-access-administration-service.js';
import type { Agent, AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentConversationBinding,
  ProviderConnectionId,
} from '../../domain/provider/provider.js';
import type { ConversationId } from '../../domain/conversation/conversation.js';
import type { MemorySubject } from '../../domain/memory/memory.js';
import {
  asGroupDiscoverySource,
  asPermissionApprovalSurface,
  asProgressSink,
  asStreamingSink,
  asStreamingStateSink,
  asTypingSink,
  asUserQuestionSurface,
} from './channel-capability-ports.js';
import {
  listChannelProviders,
  providerForJid,
} from '../../channels/provider-registry.js';
import type {
  ChannelWiring,
  ChannelWiringDeps,
} from './channel-wiring-types.js';
import { AsyncTaskQueue } from './async-task-queue.js';
import { createChannelPersistenceHandlers } from './channel-persistence-handlers.js';

export type { ChannelWiring } from './channel-wiring-types.js';

function sanitizeDeliveryError(err: unknown, provider: string): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : String(err);
  return (
    raw
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK_TOKEN]')
      .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
      .slice(0, 500)
      .trim() || `${provider} delivery failed`
  );
}

function waitForMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChannelWiring(
  app: RuntimeApp,
  deps: Partial<ChannelWiringDeps> = {},
): ChannelWiring {
  const resolved: ChannelWiringDeps = {
    appId: 'default' as AppId,
    providerIds: listChannelProviders(),
    loadSenderAllowlist,
    loadSenderControlAllowlist,
    shouldDropMessage,
    isSenderAllowed,
    isSenderControlAllowed,
    shouldLogDenied,
    asRemoteControlCommand,
    handleRemoteControlCommand,
    logger,
    runtimeSecrets: new EnvRuntimeSecretProvider(),
    ...deps,
  };

  const connectedChannels: ChannelAdapter[] = [];
  const persistenceQueue = new AsyncTaskQueue(4, 5_000);
  const ops = () => resolved.opsRepository ?? getRuntimeRepositories();
  const optionalOps = () => {
    try {
      return ops();
    } catch (err) {
      resolved.logger.debug(
        { err },
        'Runtime storage unavailable; skipping outbound message persistence',
      );
      return undefined;
    }
  };

  const channelOpts = {
    ...createChannelPersistenceHandlers({
      app,
      resolved,
      ops,
      findBoundChannel,
      persistenceQueue,
      appId: resolved.appId,
      dmAccess: {
        resolveDmAgent: (input) =>
          new AgentDmAccessAdministrationService({
            agents: getRuntimeStorage().repositories.agents,
            providerConnections:
              getRuntimeStorage().repositories.providerConnections,
            conversations: getRuntimeStorage().repositories.conversations,
          }).resolveDmAgent(input),
      },
      saveDmAgentConversationBinding,
    }),
    conversationRoutes: () => app.getConversationRoutes(),
    runtimeSettings: () => currentRuntimeSettings,
    runtimeLease: {
      tryAcquire: tryAcquireRuntimeAdvisoryLease,
    },
    runtimeSecrets: resolved.runtimeSecrets,
    isControlApproverAllowed: authorizeConversationApprover,
  };
  let currentRuntimeSettings: RuntimeSettings;

  async function saveDmAgentConversationBinding(input: {
    agent: Agent;
    chatJid: string;
    providerId: string;
  }): Promise<void> {
    const repositories = getRuntimeStorage().repositories;
    const now = new Date().toISOString();
    const conversationId = `conversation:${input.chatJid}` as ConversationId;
    const providerConnectionId =
      `channel-providerConnection:default:${input.providerId}` as ProviderConnectionId;
    await repositories.providerConnections.saveAgentConversationBinding({
      id: `agent-dm-binding:${safeIdPart(input.agent.id)}:${safeIdPart(input.chatJid)}` as AgentConversationBinding['id'],
      appId: resolved.appId,
      agentId: input.agent.id as AgentId,
      providerConnectionId,
      conversationId,
      displayName: `${input.agent.name} DM`,
      status: 'active',
      triggerMode: 'always',
      requiresTrigger: false,
      isAdminBinding: false,
      memoryScope: 'conversation',
      memorySubject: {
        kind: 'conversation',
        appId: resolved.appId,
        conversationId,
      } as MemorySubject,
      permissionPolicyIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  function safeIdPart(value: string): string {
    return value
      .trim()
      .replace(/[^a-zA-Z0-9._:@-]/g, '_')
      .slice(0, 96);
  }

  function findBoundChannel(jid: string): ChannelAdapter | undefined {
    return findChannel(connectedChannels, jid);
  }

  async function connectEnabledChannels(
    runtimeSettings: RuntimeSettings,
  ): Promise<void> {
    currentRuntimeSettings = runtimeSettings;
    for (const provider of resolved.providerIds) {
      if (!provider.isEnabled(runtimeSettings)) {
        resolved.logger.info(
          { channel: provider.id },
          'Channel disabled in settings.yaml — skipping connect',
        );
        continue;
      }

      const channel = await provider.create(channelOpts);
      if (!channel) {
        if (provider.controlCapabilityFlags?.includes('runtime-placeholder')) {
          throw new Error(
            `${provider.label} channel runtime transport is not implemented; this provider currently supports setup/discovery only. Disable providers.${provider.id}.enabled before starting the runtime.`,
          );
        }
        resolved.logger.warn(
          { channel: provider.id },
          'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
        );
        continue;
      }
      connectedChannels.push(channel);
      await channel.connect();
    }
  }

  function hasConnectedChannels(): boolean {
    return connectedChannels.length > 0;
  }

  function hasChannel(jid: string): boolean {
    return findBoundChannel(jid) !== undefined;
  }

  function supportsStreaming(jid: string): boolean {
    const channel = findBoundChannel(jid);
    if (!channel) return false;
    return asStreamingSink(channel) !== undefined;
  }

  function supportsProgress(jid: string): boolean {
    const channel = findBoundChannel(jid);
    if (!channel) return false;
    return asProgressSink(channel) !== undefined;
  }

  async function sendMessage(
    jid: string,
    rawText: string,
    options: {
      throwOnMissing?: boolean;
      messageOptions?: MessageSendOptions;
    } = {},
  ): Promise<void> {
    const channel = findBoundChannel(jid);
    if (!channel) {
      if (options.throwOnMissing) {
        throw new Error(`No channel for JID: ${jid}`);
      }
      resolved.logger.warn({ jid }, 'No channel owns JID, cannot send message');
      return;
    }

    const formatted = formatOutboundForChannel(
      rawText,
      providerForJid(jid)?.id ?? channel.name,
    );
    if (!formatted) return;
    const provider = providerForJid(jid)?.id ?? channel.name;
    const now = new Date().toISOString();
    const messageId = `outbound:${randomUUID()}`;
    const baseMessage = {
      id: messageId,
      chat_jid: jid,
      provider: provider,
      sender: 'myclaw',
      sender_name: 'MyClaw',
      content: formatted,
      timestamp: now,
      is_from_me: true,
      is_bot_message: true,
      thread_id: options.messageOptions?.threadId,
    };

    const outboundOps = optionalOps();
    await outboundOps?.storeMessage({
      ...baseMessage,
      delivery_status: 'pending',
    });

    try {
      const delivery = options.messageOptions
        ? await channel.sendMessage(jid, formatted, options.messageOptions)
        : await channel.sendMessage(jid, formatted);
      const result = delivery as MessageDeliveryResult | undefined;
      await outboundOps?.storeMessage({
        ...baseMessage,
        external_message_id: result?.externalMessageId,
        delivery_status: 'sent',
        delivered_at: new Date().toISOString(),
      });
    } catch (err) {
      const partial = isPartialMessageDeliveryError(err);
      try {
        await outboundOps?.storeMessage({
          ...baseMessage,
          delivery_status: partial ? 'partially_sent' : 'failed',
          delivered_at: partial ? new Date().toISOString() : undefined,
          delivery_error: sanitizeDeliveryError(err, provider),
        });
      } catch (persistErr) {
        resolved.logger.error(
          { err: persistErr, jid },
          'Failed to persist outbound delivery failure',
        );
      }
      throw err;
    }
  }

  async function sendStreamingChunk(
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ): Promise<boolean> {
    const channel = findBoundChannel(jid);
    if (!channel) {
      resolved.logger.warn(
        { jid },
        'No channel owns JID, cannot stream message',
      );
      return false;
    }

    const provider = providerForJid(jid);
    const isGroup = provider?.isGroupJid(jid) ?? false;
    const text = isGroup
      ? stripInternalTagsPreserveWhitespace(rawText)
      : formatOutboundForChannel(rawText, provider?.id ?? channel.name);
    if (!text && !options?.done) return false;

    const streamingSink = asStreamingSink(channel);
    if (streamingSink) {
      return streamingSink.sendStreamingChunk(jid, text || '', options);
    }

    if (!text) return false;
    const messageOptions: MessageSendOptions | undefined = options?.threadId
      ? { threadId: options.threadId }
      : undefined;
    if (messageOptions) {
      await channel.sendMessage(jid, text, messageOptions);
      return true;
    }
    await channel.sendMessage(jid, text);
    return true;
  }

  function resetStreaming(jid: string): void {
    const channel = findBoundChannel(jid);
    if (!channel) return;
    const stateSink = asStreamingStateSink(channel);
    stateSink?.resetStreaming(jid);
  }

  async function setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channel = findBoundChannel(jid);
    if (!channel) return;
    const typingSink = asTypingSink(channel);
    if (!typingSink) return;
    await typingSink.setTyping(jid, isTyping);
  }

  async function sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void> {
    const channel = findBoundChannel(jid);
    if (!channel) return;
    const progressSink = asProgressSink(channel);
    if (!progressSink) return;
    await progressSink.sendProgressUpdate(jid, text, options);
  }

  async function syncGroups(force: boolean): Promise<void> {
    const syncSources = connectedChannels
      .map(asGroupDiscoverySource)
      .filter((source): source is GroupDiscoverySource => source !== undefined);
    await Promise.all(syncSources.map((source) => source.syncGroups(force)));
  }

  async function requestPermissionApproval(
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    if (request.targetJid) {
      const routed = await resolvePermissionApprovalTarget(request);
      if ('blockedReason' in routed) {
        return { approved: false, reason: routed.blockedReason };
      }
      const channel = findBoundChannel(routed.targetJid);
      const approvalSurface = channel
        ? asPermissionApprovalSurface(channel)
        : undefined;
      if (!approvalSurface) {
        return {
          approved: false,
          reason: 'Target channel does not support permission approvals',
        };
      }
      try {
        return await approvalSurface.requestPermissionApproval(
          routed.targetJid,
          routed.request,
        );
      } catch (err) {
        resolved.logger.error(
          { err, targetJid: routed.targetJid, requestId: request.requestId },
          'Target channel permission approval flow failed',
        );
        return { approved: false, reason: 'Permission approval flow failed' };
      }
    }

    const mainEntries = Object.entries(app.getConversationRoutes()).filter(
      ([, group]) => group.isMain === true,
    );

    for (const [mainJid] of mainEntries) {
      const channel = findBoundChannel(mainJid);
      if (!channel) continue;
      const approvalSurface = asPermissionApprovalSurface(channel);
      if (!approvalSurface) continue;
      try {
        return await approvalSurface.requestPermissionApproval(
          mainJid,
          request,
        );
      } catch (err) {
        resolved.logger.error(
          { err, mainJid, requestId: request.requestId },
          'Channel permission approval flow failed',
        );
        return { approved: false, reason: 'Permission approval flow failed' };
      }
    }

    return {
      approved: false,
      reason: 'No main channel supports interactive permission approvals',
    };
  }

  async function resolvePermissionApprovalTarget(
    request: PermissionApprovalRequest,
  ): Promise<
    | { targetJid: string; request: PermissionApprovalRequest }
    | { blockedReason: string }
  > {
    const targetJid = request.targetJid;
    if (!targetJid) {
      return { blockedReason: 'Permission approval target is missing' };
    }
    const repositories = getRuntimeStorage().repositories;
    const conversationId = `conversation:${targetJid}` as ConversationId;
    const conversation =
      await repositories.conversations.getConversation(conversationId);
    const isDirectConversation =
      conversation?.kind === 'direct' || String(conversation?.kind) === 'dm';
    if (!conversation || !isDirectConversation) {
      return { targetJid, request };
    }

    let activeBindings: AgentConversationBinding[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bindings =
        await repositories.providerConnections.listAgentConversationBindingsByConversation(
          {
            appId: resolved.appId,
            conversationId,
          },
        );
      activeBindings = bindings.filter(
        (binding) => binding.status === 'active',
      );
      if (activeBindings.length === 1 || attempt === 2) break;
      await waitForMs(50 * (attempt + 1));
    }
    if (activeBindings.length !== 1) {
      return {
        blockedReason:
          'DM permission approval requires exactly one active agent binding.',
      };
    }
    const binding = activeBindings[0]!;
    const providerConnection =
      await repositories.providerConnections.getProviderConnection(
        binding.providerConnectionId,
      );
    if (!providerConnection || providerConnection.appId !== resolved.appId) {
      return {
        blockedReason:
          'DM permission approval requires a valid provider connection.',
      };
    }
    const approvers = await repositories.agents.listAgentDmApprovers({
      appId: resolved.appId,
      agentId: binding.agentId,
    });
    const providerId = providerConnection.providerId.toString();
    const approver = approvers.find(
      (candidate) => candidate.providerId.toString() === providerId,
    );
    if (!approver) {
      return {
        blockedReason:
          'DM permission approval requires a configured agent DM admin.',
      };
    }
    const provider = resolved.providerIds.find(
      (candidate) => candidate.id === providerId,
    );
    if (!provider) {
      return {
        blockedReason:
          'DM permission approval requires a connected provider for the admin.',
      };
    }
    const adminJid = approver.externalUserId.startsWith(provider.jidPrefix)
      ? approver.externalUserId
      : `${provider.jidPrefix}${approver.externalUserId}`;
    return {
      targetJid: adminJid,
      request: {
        ...request,
        targetJid: adminJid,
        approvalContextJid: targetJid,
      },
    };
  }

  async function authorizeConversationApprover(input: {
    providerId: string;
    conversationJid: string;
    userId: string;
    sourceAgentFolder: string;
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
  }): Promise<boolean> {
    if (input.decisionPolicy && input.decisionPolicy !== 'same_channel') {
      return false;
    }
    try {
      const repositories = getRuntimeStorage().repositories;
      const dmApprover = await new AgentDmAccessAdministrationService({
        agents: repositories.agents,
        providerConnections: repositories.providerConnections,
        conversations: repositories.conversations,
      }).isDmApproverAllowed({
        appId: resolved.appId,
        providerId: input.providerId,
        channelJid: input.conversationJid,
        userId: input.userId,
      });
      if (dmApprover !== null) return dmApprover;

      const service = new ConversationAdministrationService(
        {
          providerConnections: repositories.providerConnections,
          conversations: repositories.conversations,
        },
        new RuntimeSecretConversationMembershipValidator(
          new EnvRuntimeSecretProvider(),
        ),
      );
      return await service.isControlApproverAllowed({
        appId: resolved.appId,
        providerId: input.providerId as never,
        conversationJid: input.conversationJid,
        userId: input.userId,
      });
    } catch (err) {
      resolved.logger.warn(
        {
          err,
          providerId: input.providerId,
          sourceAgentFolder: input.sourceAgentFolder,
        },
        'Conversation approver lookup failed',
      );
      return false;
    }
  }

  async function requestUserAnswer(
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse> {
    if (request.targetJid) {
      const channel = findBoundChannel(request.targetJid);
      const questionSurface = channel
        ? asUserQuestionSurface(channel)
        : undefined;
      if (!questionSurface) {
        return { requestId: request.requestId, answers: {} };
      }
      try {
        return await questionSurface.requestUserAnswer(
          request.targetJid,
          request,
        );
      } catch (err) {
        resolved.logger.error(
          { err, targetJid: request.targetJid, requestId: request.requestId },
          'Target channel user question flow failed',
        );
        return { requestId: request.requestId, answers: {} };
      }
    }

    const mainEntries = Object.entries(app.getConversationRoutes()).filter(
      ([, group]) => group.isMain === true,
    );

    for (const [mainJid] of mainEntries) {
      const channel = findBoundChannel(mainJid);
      if (!channel) continue;
      const questionSurface = asUserQuestionSurface(channel);
      if (!questionSurface) continue;
      try {
        return await questionSurface.requestUserAnswer(mainJid, request);
      } catch (err) {
        resolved.logger.error(
          { err, mainJid, requestId: request.requestId },
          'Channel user question flow failed',
        );
        return { requestId: request.requestId, answers: {} };
      }
    }

    return { requestId: request.requestId, answers: {} };
  }

  async function disconnectChannels(): Promise<void> {
    const drained = await persistenceQueue.waitForIdle(5_000);
    if (!drained) {
      resolved.logger.warn(
        'Timed out waiting for channel persistence queue to drain',
      );
    }
    for (const channel of connectedChannels) {
      await channel.disconnect();
    }
    connectedChannels.length = 0;
  }

  return {
    connectEnabledChannels,
    hasConnectedChannels,
    hasChannel,
    supportsStreaming,
    supportsProgress,
    sendMessage,
    sendStreamingChunk,
    resetStreaming,
    setTyping,
    sendProgressUpdate,
    syncGroups,
    requestPermissionApproval,
    requestUserAnswer,
    disconnectChannels,
  };
}
