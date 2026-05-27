import type { ChannelAdapter } from '../../channels/channel-provider.js';
import type { ConversationRoute, NewMessage } from '../../domain/types.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { RuntimeApp } from './runtime-app.js';
import type { AsyncTaskQueue } from './async-task-queue.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';

type ChannelPersistenceRepository = RuntimeChatMetadataRepository &
  RuntimeMessageRepository;
type ConversationRouteEntry = [string, ConversationRoute];

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

async function ensureInteraktDirectRoute(input: {
  app: RuntimeApp;
  chatJid: string;
  msg: NewMessage;
  logger: ChannelWiringDeps['logger'];
}): Promise<boolean> {
  if (input.msg.provider !== 'interakt' || !input.chatJid.startsWith('wa:')) {
    return false;
  }
  const routes = input.app.getConversationRoutes();
  if (routes[input.chatJid]) return true;

  // Routing rules, in order:
  //   1. an existing conversation flagged isTemplate (settings.yaml
  //      conversations.<id>.template: true) → clone its route.
  //   2. providers.interakt.default_agent → synthesize a new route from the
  //      referenced agent block.
  // No silent fallback: if none match, return false and let the caller drop.
  //
  // We deliberately do NOT treat "any route whose JID starts with wa:" as a
  // template — once the first inbound is auto-registered the runtime ends
  // up with wa:<phone> entries that represent real customers, not templates.
  // Cloning new customers from a real-customer route would inherit the
  // wrong settings. Users must mark a route as a template explicitly or
  // configure default_agent.
  const template = findInteraktDirectRouteTemplate(routes);
  if (template) {
    const [templateJid, group] = template;
    await input.app.registerGroup(input.chatJid, {
      ...group,
      added_at: input.msg.timestamp,
      conversationKind: 'dm',
      isTemplate: false,
    });
    input.logger.info(
      {
        chatJid: input.chatJid,
        folder: group.folder,
        templateJid,
        source: 'template-flag',
      },
      'Auto-registered Interakt direct conversation route',
    );
    return true;
  }

  const interaktSettings = input.app.getProviderSettings('interakt');
  const defaultAgentFolder = interaktSettings?.defaultAgent;
  if (defaultAgentFolder) {
    const agent = input.app.getAgentSettings(defaultAgentFolder);
    if (!agent) {
      // Should be caught at parse time; defensive log.
      input.logger.error(
        { defaultAgentFolder, chatJid: input.chatJid },
        'providers.interakt.default_agent references unknown agent folder; cannot route inbound direct message',
      );
      return false;
    }
    // Mirror desired-state-service.ts's agentConfig shape so per-customer
    // routes synthesized via default_agent get the agent's runtime config.
    const agentConfig =
      agent.model || agent.persona || agent.guardrail
        ? {
            model: agent.model,
            persona: agent.persona,
            guardrail: agent.guardrail,
          }
        : undefined;
    const synthesized: ConversationRoute = {
      name: agent.name,
      folder: agent.folder,
      trigger: `@${agent.name}`,
      added_at: input.msg.timestamp,
      requiresTrigger: false,
      conversationKind: 'dm',
      ...(agentConfig ? { agentConfig } : {}),
    };
    await input.app.registerGroup(input.chatJid, synthesized);
    input.logger.info(
      {
        chatJid: input.chatJid,
        folder: agent.folder,
        source: 'default-agent',
      },
      'Auto-registered Interakt direct conversation route',
    );
    return true;
  }

  return false;
}

function findInteraktDirectRouteTemplate(
  routes: Record<string, ConversationRoute>,
): ConversationRouteEntry | undefined {
  // Match templates only when their JID is in the Interakt JID space (wa:*).
  // Without this guard, another provider's template would be picked up for
  // Interakt inbound and produce cross-channel cloning bugs.
  const entries = Object.entries(routes);
  return entries.find(
    ([jid, group]) => group.isTemplate === true && jid.startsWith('wa:'),
  );
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
    if (!existingGroup && !msg.is_from_me && !msg.is_bot_message) {
      const autoRegistered = await ensureInteraktDirectRoute({
        app,
        chatJid,
        msg,
        logger: resolved.logger,
      });
      if (autoRegistered) return true;
    }
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
      const trimmed = msg.content.trim();
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

      const remoteControlCommand = resolved.asRemoteControlCommand(trimmed);
      if (remoteControlCommand) {
        const allowlistCfg = resolved.loadSenderControlAllowlist();
        try {
          await resolved.handleRemoteControlCommand(
            remoteControlCommand,
            chatJid,
            msg,
            (jid) => app.getConversationRoutes()[jid],
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
