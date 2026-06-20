import type { ConversationRoute, NewMessage } from '../../domain/types.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
  RuntimeMessageStoreResult,
} from '../../domain/repositories/ops-repo.js';
import type { RuntimeApp } from './runtime-app.js';
import type { AsyncTaskQueue } from './async-task-queue.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';
import type { ConversationWorkNotificationPublisher } from '../../domain/ports/conversation-work-notifier.js';
import {
  IPC_EVENT_PIPE,
  IPC_EVENT_PIPE_DEBOUNCE_MS,
} from '../../config/index.js';

type ChannelPersistenceRepository = RuntimeChatMetadataRepository &
  RuntimeMessageRepository;
type ConversationRouteEntry = [string, ConversationRoute];

interface ChannelPersistenceHandlerDeps {
  app: RuntimeApp;
  resolved: ChannelWiringDeps;
  ops: () => ChannelPersistenceRepository;
  persistenceQueue: AsyncTaskQueue;
  enqueueMessageCheck?: (chatJid: string) => void;
  publishConversationWorkNotification?: ConversationWorkNotificationPublisher;
  autoRegisteredMessageCheckDelayMs?: number;
  eventPipeEnabled?: boolean;
  eventPipeDebounceMs?: number;
}

interface EnsureConversationRouteResult {
  canRoute: boolean;
  autoRegistered: boolean;
}

interface InteraktDefaultAgentRouteInput {
  app: RuntimeApp;
  chatJid: string;
  addedAt: string;
  logger: Pick<ChannelWiringDeps['logger'], 'error' | 'info'>;
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

export async function projectInteraktDefaultAgentRoute(
  input: InteraktDefaultAgentRouteInput,
): Promise<boolean> {
  if (!input.chatJid.startsWith('wa:')) return false;
  const routes = input.app.getConversationRoutes();
  if (routes[input.chatJid]) return true;

  const interaktSettings = input.app.getProviderSettings('interakt');
  const defaultAgentFolder = interaktSettings?.defaultAgent;
  if (!defaultAgentFolder) return false;

  const agent = input.app.getAgentSettings(defaultAgentFolder);
  if (!agent) {
    // Should be caught at parse time; defensive log.
    input.logger.error(
      { defaultAgentFolder, chatJid: input.chatJid },
      'providers.interakt.default_agent references unknown agent folder; cannot route inbound direct message',
    );
    return false;
  }
  // Mirror desired-state-service.ts's agentConfig shape so virtual
  // default_agent routes get the agent's runtime config
  // (declared plugins — guardrail, extraction prompt, skills — included, so
  // the gates fire here too).
  const agentConfig =
    agent.model ||
    agent.persona ||
    agent.promptSurface ||
    agent.plugins ||
    agent.thinking ||
    agent.toolSurface
      ? {
          model: agent.model,
          persona: agent.persona,
          promptSurface: agent.promptSurface,
          plugins: agent.plugins,
          thinking: agent.thinking,
          toolSurface: agent.toolSurface,
        }
      : undefined;
  const projected: ConversationRoute = {
    name: agent.name,
    folder: agent.folder,
    trigger: `@${agent.name}`,
    added_at: input.addedAt,
    requiresTrigger: false,
    conversationKind: 'dm',
    ...(agentConfig ? { agentConfig } : {}),
  };
  await input.app.projectConversationRoute(input.chatJid, projected);
  input.logger.info(
    {
      chatJid: input.chatJid,
      folder: agent.folder,
      source: 'default-agent',
    },
    'Projected virtual Interakt direct conversation route from provider default agent',
  );
  return true;
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
  //   2. providers.interakt.default_agent → project a live virtual route from
  //      the referenced agent block without writing a per-customer route row.
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

  return projectInteraktDefaultAgentRoute({
    app: input.app,
    chatJid: input.chatJid,
    addedAt: input.msg.timestamp,
    logger: input.logger,
  });
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
  persistenceQueue,
  enqueueMessageCheck,
  publishConversationWorkNotification,
  autoRegisteredMessageCheckDelayMs = 0,
  eventPipeEnabled = IPC_EVENT_PIPE,
  eventPipeDebounceMs = IPC_EVENT_PIPE_DEBOUNCE_MS,
}: ChannelPersistenceHandlerDeps) {
  const chatIsGroup = new Map<string, boolean>();
  const eventPipeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const ensureConfiguredConversationRoute = async (
    chatJid: string,
    msg: NewMessage,
  ): Promise<EnsureConversationRouteResult> => {
    const groupsByChat = app.getConversationRoutes();
    const existingGroup = groupsByChat[chatJid];
    if (!existingGroup && !msg.is_from_me && !msg.is_bot_message) {
      const autoRegistered = await ensureInteraktDirectRoute({
        app,
        chatJid,
        msg,
        logger: resolved.logger,
      });
      if (autoRegistered) return { canRoute: true, autoRegistered: true };
    }
    const isKnownDirect =
      chatIsGroup.get(chatJid) === false ||
      existingGroup?.conversationKind === 'dm';
    if (!isKnownDirect)
      return { canRoute: Boolean(existingGroup), autoRegistered: false };
    if (!existingGroup && !msg.is_from_me && !msg.is_bot_message) {
      resolved.logger.warn(
        { chatJid, sender: msg.sender },
        'Dropping direct message without configured conversation binding',
      );
    }
    return { canRoute: Boolean(existingGroup), autoRegistered: false };
  };

  const enqueuePersistedInboundMessageCheck =
    enqueueMessageCheck ?? app.queue?.enqueueMessageCheck?.bind(app.queue);

  const wakePersistedInboundMessageCheck = (
    chatJid: string,
    route: EnsureConversationRouteResult,
  ): void => {
    if (!enqueuePersistedInboundMessageCheck) return;
    if (route.autoRegistered) {
      if (autoRegisteredMessageCheckDelayMs <= 0) {
        enqueuePersistedInboundMessageCheck(chatJid);
      } else {
        const timer = setTimeout(
          () => enqueuePersistedInboundMessageCheck(chatJid),
          autoRegisteredMessageCheckDelayMs,
        );
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
          (timer as { unref(): void }).unref();
        }
      }
      return;
    }

    if (!eventPipeEnabled) {
      enqueuePersistedInboundMessageCheck(chatJid);
      return;
    }

    const existing = eventPipeTimers.get(chatJid);
    if (existing) clearTimeout(existing);
    const delayMs = Math.max(0, eventPipeDebounceMs);
    const timer = setTimeout(() => {
      eventPipeTimers.delete(chatJid);
      enqueuePersistedInboundMessageCheck(chatJid);
    }, delayMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref(): void }).unref();
    }
    eventPipeTimers.set(chatJid, timer);
  };

  const prewarmAfterPersistence = async (
    chatJid: string,
    route: EnsureConversationRouteResult,
  ): Promise<void> => {
    if (!route.autoRegistered) return;
    const folder = app.getConversationRoutes()[chatJid]?.folder;
    await app.prewarmAgentForConversationRoute(chatJid).catch((err) => {
      resolved.logger.warn(
        { err, chatJid, folder },
        'Failed to prewarm auto-registered Interakt direct conversation',
      );
    });
  };

  const publishPersistedInboundWorkNotification = async (
    chatJid: string,
    msg: NewMessage,
    storeResult: RuntimeMessageStoreResult | undefined,
  ): Promise<void> => {
    if (!publishConversationWorkNotification) return;
    try {
      await publishConversationWorkNotification({
        appId: resolved.appId,
        conversationId: chatJid,
        threadId: msg.thread_id ?? null,
        messageId: storeResult?.messageId ?? `message:${chatJid}:${msg.id}`,
      });
    } catch (err) {
      resolved.logger.warn(
        { err, chatJid, messageId: storeResult?.messageId ?? msg.id },
        'Failed to publish conversation work notification; recovery reconciler must pick up persisted message',
      );
    }
  };

  return {
    ensureMessageRoute: async (chatJid: string, msg: NewMessage) =>
      (await ensureConfiguredConversationRoute(chatJid, msg)).canRoute,
    onMessage: async (chatJid: string, msg: NewMessage) => {
      const route = await ensureConfiguredConversationRoute(chatJid, msg);
      if (!route.canRoute) return;
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

      let storeResult: RuntimeMessageStoreResult | undefined;
      const persistMessage = async () => {
        try {
          storeResult = await ops().storeMessage(msg);
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
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        storeResult?.status !== 'duplicate_existing_message'
      ) {
        await prewarmAfterPersistence(chatJid, route);
        await publishPersistedInboundWorkNotification(
          chatJid,
          msg,
          storeResult,
        );
        if (publishConversationWorkNotification) return;
        wakePersistedInboundMessageCheck(chatJid, route);
      }
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
