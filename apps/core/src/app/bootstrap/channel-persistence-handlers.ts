import type { ChannelAdapter } from '../../channels/channel-provider.js';
import type { NewMessage } from '../../domain/types.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { RuntimeApp } from './runtime-app.js';
import type { AsyncTaskQueue } from './async-task-queue.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';

type ChannelPersistenceRepository = RuntimeChatMetadataRepository &
  RuntimeMessageRepository;

interface ChannelPersistenceHandlerDeps {
  app: RuntimeApp;
  resolved: ChannelWiringDeps;
  ops: () => ChannelPersistenceRepository;
  findBoundChannel: (jid: string) => ChannelAdapter | undefined;
  persistenceQueue: AsyncTaskQueue;
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
}: ChannelPersistenceHandlerDeps) {
  const chatIsGroup = new Map<string, boolean>();

  const ensureConfiguredConversationRoute = async (
    chatJid: string,
    msg: NewMessage,
  ): Promise<boolean> => {
    const groupsByChat = app.getConversationRoutes();
    const existingGroup = groupsByChat[chatJid];
    const isKnownDirect =
      chatIsGroup.get(chatJid) === false ||
      existingGroup?.conversationKind === 'dm';
    if (!isKnownDirect) return Boolean(existingGroup);
    if (!existingGroup && !msg.is_from_me && !msg.is_bot_message) {
      resolved.logger.warn(
        { chatJid, sender: msg.sender },
        'Dropping direct message without configured conversation binding',
      );
    }
    return Boolean(existingGroup);
  };

  return {
    ensureMessageRoute: ensureConfiguredConversationRoute,
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const canRoute = await ensureConfiguredConversationRoute(chatJid, msg);
      if (!canRoute) return;
      const groupsByChat = app.getConversationRoutes();
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
