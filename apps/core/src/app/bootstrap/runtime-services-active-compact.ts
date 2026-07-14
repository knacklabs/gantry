import type { MessageSendOptions, NewMessage } from '../../domain/types.js';
import {
  isSenderControlAllowed,
  loadSenderControlAllowlist,
} from '../../platform/sender-allowlist.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
  type SessionCommand,
} from '../../session/session-commands.js';
import { buildTriggerPattern } from '../../shared/trigger-pattern.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import type { LiveTurnAuthority } from '../../runtime/live-turn-authority.js';
import {
  liveTurnScopeForQueue,
  type LiveTurnScopeRepository,
} from './live-recovery-coordinator.js';
import { controlAckMessageOptions } from './runtime-services-active-new.js';

const activeCompactReceipts = new Set<string>();

type ActiveCompactHandler = (args: {
  chatJid: string;
  queueJid: string;
  group: {
    folder: string;
    trigger?: string;
    conversationKind?: 'dm' | 'channel';
    providerAccountId?: string;
  };
  message: NewMessage;
  command: SessionCommand;
}) => Promise<boolean> | boolean;

export async function handleActiveCompactRouteMessage(input: {
  message: NewMessage;
  route: {
    folder: string;
    trigger?: string;
    conversationKind?: 'dm' | 'channel';
    providerAccountId?: string;
  };
  chatJid: string;
  queueJid: string;
  handleActiveControlCommand?: ActiveCompactHandler;
}): Promise<boolean> {
  if (!isActiveCompactRouteMessage(input)) return false;
  return input.handleActiveControlCommand!({
    chatJid: input.chatJid,
    queueJid: input.queueJid,
    group: input.route,
    message: input.message,
    command: extractSessionCommand(
      input.message.content,
      buildTriggerPattern(input.route.trigger ?? ''),
    )!,
  });
}

export function isActiveCompactRouteMessage(input: {
  message: NewMessage;
  route: {
    folder: string;
    trigger?: string;
  };
  chatJid: string;
  handleActiveControlCommand?: ActiveCompactHandler;
}): boolean {
  const { message, route } = input;
  const command = extractSessionCommand(
    message.content,
    buildTriggerPattern(route.trigger ?? ''),
  );
  if (command?.kind !== 'compact' || !input.handleActiveControlCommand) {
    return false;
  }
  const controlAllowlistCfg = loadSenderControlAllowlist();
  if (
    !isSessionCommandAllowed(
      message.is_from_me === true,
      isSenderControlAllowed(
        input.chatJid,
        message.sender,
        controlAllowlistCfg,
        route.folder,
      ),
    )
  ) {
    return false;
  }
  return true;
}

export function createActiveCompactRouteHandlers(input: {
  route: {
    folder: string;
    trigger?: string;
    conversationKind?: 'dm' | 'channel';
    providerAccountId?: string;
  };
  chatJid: string;
  queueJid: string;
  handleActiveControlCommand?: ActiveCompactHandler;
}) {
  return {
    isActiveControlMessage: (message: NewMessage) =>
      isActiveCompactRouteMessage({ ...input, message }),
    handleActiveControlMessage: (message: NewMessage) =>
      handleActiveCompactRouteMessage({ ...input, message }),
  };
}

export async function queueActiveCompaction(input: {
  hasActiveTurn: boolean;
  findActiveLiveTurn: () => Promise<boolean>;
  enqueueMessageCheck: () => void;
  sendQueuedReceipt: () => Promise<void>;
  receiptDedupeKey?: string;
}): Promise<boolean> {
  const hasActiveTurn =
    input.hasActiveTurn || (await input.findActiveLiveTurn());
  if (!hasActiveTurn) {
    if (input.receiptDedupeKey) {
      activeCompactReceipts.delete(input.receiptDedupeKey);
    }
    return false;
  }
  if (
    input.receiptDedupeKey &&
    activeCompactReceipts.has(input.receiptDedupeKey)
  ) {
    return true;
  }
  if (input.receiptDedupeKey) {
    activeCompactReceipts.add(input.receiptDedupeKey);
  }
  input.enqueueMessageCheck();
  await input.sendQueuedReceipt();
  return true;
}

export function queueActiveCompactionForRuntime(input: {
  hasActiveTurn: boolean;
  liveTurnAuthority: LiveTurnAuthority | undefined;
  app: {
    queue: { enqueueMessageCheck(queueJid: string): boolean };
    getConversationRoutes(): Record<
      string,
      {
        folder: string;
        conversationKind?: 'channel' | 'dm';
        agentConfig?: { model?: string };
      }
    >;
  };
  opsRepository: LiveTurnScopeRepository;
  executionAdapter: { id: ExecutionProviderId };
  queueJid: string;
  message?: Pick<NewMessage, 'id' | 'timestamp'>;
  sendQueuedReceipt: () => Promise<void>;
}): Promise<boolean> {
  const messageKey = input.message?.id || input.message?.timestamp;
  return queueActiveCompaction({
    hasActiveTurn: input.hasActiveTurn,
    findActiveLiveTurn: async () => {
      if (!input.liveTurnAuthority) return false;
      const scope = await liveTurnScopeForQueue(input);
      return (
        !!scope && !!(await input.liveTurnAuthority.getActiveLiveTurn(scope))
      );
    },
    enqueueMessageCheck: () =>
      input.app.queue.enqueueMessageCheck(input.queueJid),
    sendQueuedReceipt: input.sendQueuedReceipt,
    receiptDedupeKey: messageKey
      ? `${input.queueJid}:${messageKey}`
      : undefined,
  });
}

type ActiveControlReceiptInput = {
  sendMessage: (
    text: string,
    options: {
      durability: 'required';
      messageOptions?: MessageSendOptions;
    },
  ) => Promise<void>;
  threadId?: string;
  providerAccountId?: string;
};

export function sendActiveControlReceipt(
  input: ActiveControlReceiptInput & { text: string },
): Promise<void> {
  const messageOptions = controlAckMessageOptions(
    input.threadId,
    input.providerAccountId,
  );
  return input.sendMessage(input.text, {
    durability: 'required',
    ...(messageOptions ? { messageOptions } : {}),
  });
}

export function sendActiveCompactionQueuedReceipt(
  input: ActiveControlReceiptInput,
): Promise<void> {
  return sendActiveControlReceipt({
    ...input,
    text: "Compaction queued. You can keep messaging me; I'll use the compacted context when it's ready.",
  });
}
