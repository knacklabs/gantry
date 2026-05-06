import { createHash } from 'node:crypto';

import type { ChannelAdapter } from '../../channels/channel-provider.js';
import type { RegisteredGroup, NewMessage } from '../../domain/types.js';
import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import type { Agent } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { RuntimeApp } from './runtime-app.js';
import type { AsyncTaskQueue } from './async-task-queue.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';

interface ChannelPersistenceHandlerDeps {
  app: RuntimeApp;
  resolved: ChannelWiringDeps;
  ops: () => OpsRepository;
  findBoundChannel: (jid: string) => ChannelAdapter | undefined;
  persistenceQueue: AsyncTaskQueue;
  appId: AppId;
  dmAccess?: {
    resolveDmAgent(input: {
      appId: AppId;
      providerId: string;
      externalUserId: string;
    }): Promise<
      | { status: 'none' }
      | { status: 'single'; agent: Agent }
      | { status: 'ambiguous'; agents: Agent[] }
    >;
  };
  saveDmAgentConversationBinding?: (input: {
    agent: Agent;
    chatJid: string;
    providerId: string;
  }) => Promise<void>;
}

async function enqueueAndWait(
  queue: AsyncTaskQueue,
  task: () => Promise<void>,
  onFull: () => void,
): Promise<void> {
  let resolveCompletion!: () => void;
  let rejectCompletion!: (err: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const wrapped = async () => {
    try {
      await task();
      resolveCompletion();
    } catch (err) {
      rejectCompletion(err);
    }
  };
  const admitted = queue.enqueue(wrapped);
  if (!admitted) {
    onFull();
    await queue.enqueueWhenAvailable(wrapped);
  }
  await completion;
}

export function createChannelPersistenceHandlers({
  app,
  resolved,
  ops,
  findBoundChannel,
  persistenceQueue,
  appId,
  dmAccess,
  saveDmAgentConversationBinding,
}: ChannelPersistenceHandlerDeps) {
  const chatIsGroup = new Map<string, boolean>();

  const ensureDmAgentRegistration = async (
    chatJid: string,
    msg: NewMessage,
  ): Promise<boolean> => {
    const groupsByChat = app.getRegisteredGroups();
    const existingGroup = groupsByChat[chatJid];
    if (msg.is_from_me || msg.is_bot_message) return Boolean(existingGroup);
    const isKnownDirect =
      chatIsGroup.get(chatJid) === false ||
      existingGroup?.folder.startsWith('dm_') === true;
    if (!isKnownDirect) return Boolean(existingGroup);

    const providerId = providerIdForMessage(chatJid, msg);
    const externalUserId = msg.sender.trim();
    if (!providerId || !externalUserId) return false;
    if (!dmAccess || !saveDmAgentConversationBinding) return false;

    const resolution = await dmAccess.resolveDmAgent({
      appId,
      providerId,
      externalUserId,
    });

    if (resolution.status === 'none') {
      resolved.logger.debug(
        { chatJid, providerId, externalUserId },
        'Dropping direct message without active agent DM access',
      );
      return false;
    }
    if (resolution.status === 'ambiguous') {
      resolved.logger.warn(
        {
          chatJid,
          providerId,
          externalUserId,
          agentIds: resolution.agents.map((agent) => agent.id),
        },
        'Dropping direct message because DM access matches multiple agents',
      );
      return false;
    }

    const group = dmAgentGroup(providerId, resolution.agent, chatJid);
    if (existingGroup?.folder === group.folder) return true;
    if (existingGroup) {
      resolved.logger.info(
        {
          chatJid,
          providerId,
          externalUserId,
          previousFolder: existingGroup.folder,
          nextFolder: group.folder,
          agentId: resolution.agent.id,
        },
        'Refreshing direct conversation registration from agent DM access',
      );
    }
    await saveDmAgentConversationBinding({
      agent: resolution.agent,
      chatJid,
      providerId,
    });
    await app.registerGroup(chatJid, group);
    resolved.logger.info(
      { chatJid, providerId, externalUserId, agentId: resolution.agent.id },
      'Registered direct conversation from agent DM access',
    );
    return true;
  };

  return {
    ensureMessageRoute: ensureDmAgentRegistration,
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const trimmed = msg.content.trim();
      const canRoute = await ensureDmAgentRegistration(chatJid, msg);
      if (!canRoute) return;
      const groupsByChat = app.getRegisteredGroups();
      if (!msg.is_from_me && !msg.is_bot_message && groupsByChat[chatJid]) {
        const cfg = resolved.loadSenderAllowlist();
        if (
          resolved.shouldDropMessage(
            chatJid,
            cfg,
            groupsByChat[chatJid]?.folder,
          ) &&
          !resolved.isSenderAllowed(
            chatJid,
            msg.sender,
            cfg,
            groupsByChat[chatJid]?.folder,
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
        const allowlistCfg = resolved.loadSenderControlAllowlist();
        try {
          await resolved.handleRemoteControlCommand(
            remoteControlCommand,
            chatJid,
            msg,
            (jid) => app.getRegisteredGroups()[jid],
            findBoundChannel,
            (candidateMsg) =>
              resolved.isSenderControlAllowed(
                chatJid,
                candidateMsg.sender,
                allowlistCfg,
                groupsByChat[chatJid]?.folder,
              ),
          );
        } catch (err) {
          resolved.logger.error(
            { err, chatJid },
            'Remote control command error',
          );
        }
        return;
      }

      const persistMessage = async () => {
        try {
          await ops().storeMessage(msg);
        } catch (err) {
          resolved.logger.error({ err, chatJid }, 'Failed to store message');
          throw err;
        }
      };
      await enqueueAndWait(persistenceQueue, persistMessage, () =>
        resolved.logger.warn(
          { chatJid, queueSize: persistenceQueue.size() },
          'Persistence queue full; waiting to enqueue message persistence',
        ),
      );
    },
    onChatMetadata: async (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => {
      if (isGroup !== undefined) chatIsGroup.set(chatJid, Boolean(isGroup));
      const persistMetadata = async () => {
        try {
          await ops().storeChatMetadata(
            chatJid,
            timestamp,
            name,
            channel,
            isGroup,
          );
        } catch (err) {
          resolved.logger.error(
            { err, chatJid },
            'Failed to store chat metadata',
          );
          throw err;
        }
      };
      await enqueueAndWait(persistenceQueue, persistMetadata, () =>
        resolved.logger.warn(
          { chatJid, queueSize: persistenceQueue.size() },
          'Persistence queue full; waiting to enqueue chat metadata persistence',
        ),
      );
    },
  };
}

function providerIdForMessage(_chatJid: string, msg: NewMessage): string {
  return msg.provider?.trim().toLowerCase() || 'app';
}

function dmAgentGroup(
  providerId: string,
  agent: Agent,
  chatJid: string,
): RegisteredGroup {
  return {
    name: `${agent.name} DM`,
    folder: agentDmFolder(providerId, agent.id, chatJid),
    trigger: `@${agent.name}`,
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
    conversationKind: 'dm',
  };
}

function agentDmFolder(
  providerId: string,
  agentId: string,
  chatJid: string,
): string {
  const hash = createHash('sha256')
    .update(`${providerId}:${agentId}:${chatJid}`)
    .digest('hex')
    .slice(0, 16);
  return `dm_${safeIdPart(providerId)}_${hash}`;
}

function safeIdPart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._:@-]/g, '_')
    .slice(0, 96);
}
