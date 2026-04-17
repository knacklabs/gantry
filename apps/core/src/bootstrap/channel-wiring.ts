import '../channels/index.js';

import {
  getChannelFactory,
  getRegisteredChannelNames,
} from '../channels/registry.js';
import { RuntimeSettings } from '../cli/runtime-settings.js';
import { logger } from '../core/logger.js';
import {
  Channel,
  NewMessage,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
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
import { RuntimeApp } from './runtime-app.js';

interface ChannelWiringDeps {
  getRegisteredChannelNames: () => string[];
  getChannelFactory: typeof getChannelFactory;
  storeMessage: typeof storeMessage;
  storeChatMetadata: typeof storeChatMetadata;
  loadSenderAllowlist: typeof loadSenderAllowlist;
  shouldDropMessage: typeof shouldDropMessage;
  isSenderAllowed: typeof isSenderAllowed;
  shouldLogDenied: typeof shouldLogDenied;
  asRemoteControlCommand: typeof asRemoteControlCommand;
  handleRemoteControlCommand: typeof handleRemoteControlCommand;
  logger: Pick<typeof logger, 'info' | 'warn' | 'debug' | 'error'>;
}

export interface ChannelWiring {
  connectEnabledChannels: (runtimeSettings: RuntimeSettings) => Promise<void>;
  findChannel: (jid: string) => Channel | undefined;
  sendMessage: (
    jid: string,
    rawText: string,
    options?: { throwOnMissing?: boolean },
  ) => Promise<void>;
  sendStreamingChunk: (
    jid: string,
    rawText: string,
    options?: StreamingChunkOptions,
  ) => Promise<void>;
  resetStreaming: (jid: string) => void;
  syncGroups: (force: boolean) => Promise<void>;
  requestPermissionApproval: (
    request: PermissionApprovalRequest,
  ) => Promise<PermissionApprovalDecision>;
  requestUserAnswer: (
    request: UserQuestionRequest,
  ) => Promise<UserQuestionResponse>;
}

function makeDefaultDeps(): ChannelWiringDeps {
  return {
    getRegisteredChannelNames,
    getChannelFactory,
    storeMessage,
    storeChatMetadata,
    loadSenderAllowlist,
    shouldDropMessage,
    isSenderAllowed,
    shouldLogDenied,
    asRemoteControlCommand,
    handleRemoteControlCommand,
    logger,
  };
}

export function createChannelWiring(
  app: RuntimeApp,
  deps: Partial<ChannelWiringDeps> = {},
): ChannelWiring {
  const resolved: ChannelWiringDeps = {
    ...makeDefaultDeps(),
    ...deps,
  };

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
        resolved
          .handleRemoteControlCommand(
            remoteControlCommand,
            chatJid,
            msg,
            (jid) => app.getRegisteredGroups()[jid],
            (jid) => findChannel(app.channels, jid),
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

  async function connectEnabledChannels(
    runtimeSettings: RuntimeSettings,
  ): Promise<void> {
    for (const channelName of resolved.getRegisteredChannelNames()) {
      if (
        channelName === 'telegram' &&
        !runtimeSettings.channels.telegram.enabled
      ) {
        resolved.logger.info(
          { channel: channelName },
          'Channel disabled in settings.yaml — skipping connect',
        );
        continue;
      }
      if (channelName === 'slack' && !runtimeSettings.channels.slack.enabled) {
        resolved.logger.info(
          { channel: channelName },
          'Channel disabled in settings.yaml — skipping connect',
        );
        continue;
      }

      const factory = resolved.getChannelFactory(channelName);
      if (!factory) continue;

      const channel = factory(channelOpts);
      if (!channel) {
        resolved.logger.warn(
          { channel: channelName },
          'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
        );
        continue;
      }
      app.channels.push(channel);
      await channel.connect();
    }
  }

  function findBoundChannel(jid: string): Channel | undefined {
    return findChannel(app.channels, jid);
  }

  async function sendMessage(
    jid: string,
    rawText: string,
    options: { throwOnMissing?: boolean } = {},
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

    if (channel.sendStreamingChunk) {
      await channel.sendStreamingChunk(jid, text || '', options);
      return;
    }

    if (!text) return;
    const messageOptions = options?.threadId
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
    channel.resetStreaming?.(jid);
  }

  async function syncGroups(force: boolean): Promise<void> {
    await Promise.all(
      app.channels
        .filter((ch) => ch.syncGroups)
        .map((ch) => ch.syncGroups!(force)),
    );
  }

  async function requestPermissionApproval(
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision> {
    const mainEntries = Object.entries(app.getRegisteredGroups()).filter(
      ([, group]) => group.isMain === true,
    );
    for (const [mainJid] of mainEntries) {
      const channel = findBoundChannel(mainJid);
      if (!channel?.requestPermissionApproval) continue;
      try {
        return await channel.requestPermissionApproval(mainJid, request);
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
      if (!channel?.requestUserAnswer) continue;
      try {
        return await channel.requestUserAnswer(mainJid, request);
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

  return {
    connectEnabledChannels,
    findChannel: findBoundChannel,
    sendMessage,
    sendStreamingChunk,
    resetStreaming,
    syncGroups,
    requestPermissionApproval,
    requestUserAnswer,
  };
}
