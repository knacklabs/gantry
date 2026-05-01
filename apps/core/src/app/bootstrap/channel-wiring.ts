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
  getRuntimeOpsRepository,
  tryAcquireRuntimeAdvisoryLease,
} from '../../adapters/storage/postgres/runtime-store.js';
import { ChannelAdapter } from '../../channels/channel-provider.js';
import { EnvRuntimeSecretProvider } from '../../adapters/credentials/env-runtime-secret-provider.js';
import { RuntimeApp } from './runtime-app.js';
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

export function createChannelWiring(
  app: RuntimeApp,
  deps: Partial<ChannelWiringDeps> = {},
): ChannelWiring {
  const resolved: ChannelWiringDeps = {
    channelProviders: listChannelProviders(),
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
  const ops = () => resolved.opsRepository ?? getRuntimeOpsRepository();
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
    }),
    registeredGroups: () => app.getRegisteredGroups(),
    runtimeSettings: () => currentRuntimeSettings,
    runtimeLease: {
      tryAcquire: tryAcquireRuntimeAdvisoryLease,
    },
    runtimeSecrets: resolved.runtimeSecrets,
  };
  let currentRuntimeSettings: RuntimeSettings;

  function findBoundChannel(jid: string): ChannelAdapter | undefined {
    return findChannel(connectedChannels, jid);
  }

  async function connectEnabledChannels(
    runtimeSettings: RuntimeSettings,
  ): Promise<void> {
    currentRuntimeSettings = runtimeSettings;
    for (const provider of resolved.channelProviders) {
      if (!provider.isEnabled(runtimeSettings)) {
        resolved.logger.info(
          { channel: provider.id },
          'Channel disabled in settings.yaml — skipping connect',
        );
        continue;
      }

      const channel = await provider.create(channelOpts);
      if (!channel) {
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
      channel_provider: provider,
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
      const channel = findBoundChannel(request.targetJid);
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
          request.targetJid,
          request,
        );
      } catch (err) {
        resolved.logger.error(
          { err, targetJid: request.targetJid, requestId: request.requestId },
          'Target channel permission approval flow failed',
        );
        return { approved: false, reason: 'Permission approval flow failed' };
      }
    }

    const mainEntries = Object.entries(app.getRegisteredGroups()).filter(
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

    const mainEntries = Object.entries(app.getRegisteredGroups()).filter(
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
