import type { ConversationRoute, NewMessage } from '../domain/types.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';

/** Decision 0090: in a group that needs a mention, may this sender reach the agent? */
export function senderMayTrigger(
  group: Pick<ConversationRoute, 'folder' | 'requiresTrigger'>,
  chatJid: string,
  message: Pick<NewMessage, 'sender' | 'is_from_me'>,
  allowlistCfg = loadSenderAllowlist(),
): boolean {
  return (
    group.requiresTrigger === false ||
    message.is_from_me ||
    isTriggerAllowed(chatJid, message.sender, allowlistCfg, group.folder)
  );
}

// A media message's text follows its placeholder, e.g. "[Photo] (ref) @Helper hi".
const MEDIA_PLACEHOLDER = /^\[[^\]]*\](?: \([^)]*\))?\s*/;

/**
 * The one rule for whether a taken batch is for the agent. In a group that
 * needs a mention, a batch starts a turn when a message from a sender who may
 * trigger the agent (decision 0090):
 * - mentions the bot natively, or starts with this route's own trigger;
 * - is in a thread or topic where the bot already replied;
 * - arrived while this agent's turn was running;
 * - replies to the bot's message.
 * Otherwise the batch is kept as history.
 */
export async function decideBatch(input: {
  group: Pick<
    ConversationRoute,
    'folder' | 'requiresTrigger' | 'providerAccountId'
  >;
  chatJid: string;
  threadId?: string | null;
  triggerPattern: RegExp;
  messages: readonly NewMessage[];
  /** Batch messages saved while this agent's turn was running. */
  receivedDuringTurn: ReadonlySet<NewMessage>;
  messageRepository: Pick<RuntimeMessageRepository, 'hasSentBotMessage'>;
}): Promise<boolean> {
  if (input.group.requiresTrigger === false) return true;
  const allowlistCfg = loadSenderAllowlist();
  // Only allowed senders count, so a continuation needs one in this batch;
  // who started a thread says nothing about who is asking now.
  const allowed = input.messages.filter((message) =>
    senderMayTrigger(input.group, input.chatJid, message, allowlistCfg),
  );
  if (allowed.length === 0) return false;
  const addressesThisRoute = (message: NewMessage) => {
    const text = message.content.trim();
    return (
      input.triggerPattern.test(text) ||
      (!!message.attachments?.length &&
        input.triggerPattern.test(text.replace(MEDIA_PLACEHOLDER, '')))
    );
  };
  if (
    allowed.some(
      (message) =>
        message.mentionsBot ||
        addressesThisRoute(message) ||
        input.receivedDuringTurn.has(message),
    )
  )
    return true;

  const botSpokeIn = async (where: {
    threadId?: string;
    externalMessageId?: string;
  }) =>
    (await input.messageRepository.hasSentBotMessage?.(input.chatJid, {
      ...where,
      providerAccountId: input.group.providerAccountId,
    })) === true;
  if (input.threadId && (await botSpokeIn({ threadId: input.threadId })))
    return true;
  for (const message of allowed) {
    if (
      message.reply_to_message_id &&
      (await botSpokeIn({ externalMessageId: message.reply_to_message_id }))
    )
      return true;
  }
  return false;
}
