import { RuntimeSettings } from '../cli/runtime-settings.js';
import { logger } from '../core/logger.js';
import {
  GroupDiscoverySource,
  MessageSendOptions,
  NewMessage,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  ProgressUpdateOptions,
  StreamingChunkOptions,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../core/types.js';
import {
  findChannel,
  formatOutboundForChannel,
  stripInternalTagsPreserveWhitespace,
} from '../messaging/router.js';
import {
  isSenderExplicitlyAllowed,
  isSenderAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
  shouldLogDenied,
} from '../platform/sender-allowlist.js';
import {
  asRemoteControlCommand,
  handleRemoteControlCommand,
} from '../runtime/remote-control-command.js';
import { storeChatMetadata, storeMessage } from '../storage/db.js';
import { ChannelAdapter } from '../channels/channel-provider.js';
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
  BUILTIN_CHANNEL_PROVIDERS,
  ChannelProvider,
} from './channel-providers.js';

interface ChannelWiringDeps {
  channelProviders: readonly ChannelProvider[];
  storeMessage: typeof storeMessage;
  storeChatMetadata: typeof storeChatMetadata;
  loadSenderAllowlist: typeof loadSenderAllowlist;
  shouldDropMessage: typeof shouldDropMessage;
  isSenderAllowed: typeof isSenderAllowed;
  isSenderExplicitlyAllowed: typeof isSenderExplicitlyAllowed;
  shouldLogDenied: typeof shouldLogDenied;
  asRemoteControlCommand: typeof asRemoteControlCommand;
  handleRemoteControlCommand: typeof handleRemoteControlCommand;
  logger: Pick<typeof logger, 'info' | 'warn' | 'debug' | 'error'>;
}

export interface ChannelWiring {
  connectEnabledChannels: (runtimeSettings: RuntimeSettings) => Promise<void>;
  hasConnectedChannels: () => boolean;
  hasChannel: (jid: string) => boolean;
  supportsStreaming: (jid: string) => boolean;
  supportsProgress: (jid: string) => boolean;
  sendMessage: (
    jid: string,
    rawText: string,
    options?: { throwOnMissing?: boolean; messageOptions?: MessageSendOptions },
  ) => Promise<void>;
  sendStreamingChunk: (
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ) => Promise<void>;
  resetStreaming: (jid: string) => void;
  setTyping: (jid: string, isTyping: boolean) => Promise<void>;
  sendProgressUpdate: (
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<void>;
  syncGroups: (force: boolean) => Promise<void>;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
  disconnectChannels: () => Promise<void>;
}

export function createChannelWiring(
  app: RuntimeApp,
  deps: Partial<ChannelWiringDeps> = {},
): ChannelWiring {
  const resolved: ChannelWiringDeps = {
    channelProviders: BUILTIN_CHANNEL_PROVIDERS,
    storeMessage,
    storeChatMetadata,
    loadSenderAllowlist,
    shouldDropMessage,
    isSenderAllowed,
    isSenderExplicitlyAllowed,
    shouldLogDenied,
    asRemoteControlCommand,
    handleRemoteControlCommand,
    logger,
    ...deps,
  };

  const connectedChannels: ChannelAdapter[] = [];

  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      const trimmed = msg.content.trim();
      const registeredGroups = app.getRegisteredGroups();
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = resolved.loadSenderAllowlist();
        if (
          resolved.shouldDropMessage(
            chatJid,
            cfg,
            registeredGroups[chatJid]?.folder,
          ) &&
          !resolved.isSenderAllowed(
            chatJid,
            msg.sender,
            cfg,
            registeredGroups[chatJid]?.folder,
          )
        ) {
          if (resolved.shouldLogDenied(chatJid, cfg)) {
            resolved.logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }

      const remoteControlCommand = resolved.asRemoteControlCommand(trimmed);
      if (remoteControlCommand) {
        const allowlistCfg = resolved.loadSenderAllowlist();
        resolved
          .handleRemoteControlCommand(
            remoteControlCommand,
            chatJid,
            msg,
            (jid) => app.getRegisteredGroups()[jid],
            (jid) => findBoundChannel(jid),
            (candidateMsg) =>
              resolved.isSenderExplicitlyAllowed(
                chatJid,
                candidateMsg.sender,
                allowlistCfg,
                registeredGroups[chatJid]?.folder,
              ),
          )
          .catch((err) =>
            resolved.logger.error(
              { err, chatJid },
              'Remote control command error',
            ),
          );
        return;
      }

      resolved.storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => resolved.storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => app.getRegisteredGroups(),
  };

  function findBoundChannel(jid: string): ChannelAdapter | undefined {
    return findChannel(connectedChannels, jid);
  }

  async function connectEnabledChannels(
    runtimeSettings: RuntimeSettings,
  ): Promise<void> {
    for (const provider of resolved.channelProviders) {
      if (!provider.isEnabled(runtimeSettings)) {
        resolved.logger.info(
          { channel: provider.id },
          'Channel disabled in settings.yaml — skipping connect',
        );
        continue;
      }

      const channel = provider.create(channelOpts);
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

    const formatted = formatOutboundForChannel(rawText, channel.name);
    if (!formatted) return;
    if (options.messageOptions) {
      await channel.sendMessage(jid, formatted, options.messageOptions);
      return;
    }
    await channel.sendMessage(jid, formatted);
  }

  async function sendStreamingChunk(
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ): Promise<void> {
    const channel = findBoundChannel(jid);
    if (!channel) {
      resolved.logger.warn(
        { jid },
        'No channel owns JID, cannot stream message',
      );
      return;
    }

    const isTelegramGroup =
      channel.name === 'telegram' && jid.startsWith('tg:-');
    const text = isTelegramGroup
      ? stripInternalTagsPreserveWhitespace(rawText)
      : formatOutboundForChannel(rawText, channel.name);
    if (!text && !options?.done) return;

    const streamingSink = asStreamingSink(channel);
    if (streamingSink) {
      await streamingSink.sendStreamingChunk(jid, text || '', options);
      return;
    }

    if (!text) return;
    const messageOptions: MessageSendOptions | undefined = options?.threadId
      ? { threadId: options.threadId }
      : undefined;
    if (messageOptions) {
      await channel.sendMessage(jid, text, messageOptions);
      return;
    }
    await channel.sendMessage(jid, text);
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
