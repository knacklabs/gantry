import type { ConversationRoute, NewMessage } from '../domain/types.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';

/**
 * The one rule for whether a taken batch is for the agent. In a group that
 * needs a mention, a batch starts a turn when a message from a sender who may
 * trigger the agent (decision 0090):
 * - mentions the bot;
 * - is in a thread or topic where the bot already replied;
 * - arrived while an earlier turn in this conversation was running;
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
  /** Batch messages saved while an earlier turn in this scope was running. */
  receivedDuringTurn: ReadonlySet<NewMessage>;
  messageRepository: Pick<RuntimeMessageRepository, 'getContextMessagesSince'>;
  pageSize: number;
}): Promise<boolean> {
  if (input.group.requiresTrigger === false) return true;
  const allowlistCfg = loadSenderAllowlist();
  // Only allowed senders count, so a continuation needs one in this batch;
  // who started a thread says nothing about who is asking now.
  const allowed = input.messages.filter(
    (message) =>
      message.is_from_me ||
      isTriggerAllowed(
        input.chatJid,
        message.sender,
        allowlistCfg,
        input.group.folder,
      ),
  );
  if (allowed.length === 0) return false;
  // The text trigger is the fallback for adapters that don't set the flag.
  // A message sent while the agent was working joins the conversation.
  if (
    allowed.some(
      (message) =>
        message.mentionsBot ||
        input.triggerPattern.test(message.content.trim()) ||
        input.receivedDuringTurn.has(message),
    )
  )
    return true;

  const providerAccountId = input.group.providerAccountId;
  const botSpokeIn = async (
    limit: number,
    options: { threadId?: string | null; externalMessageId?: string },
  ) =>
    (
      (await input.messageRepository.getContextMessagesSince?.(
        input.chatJid,
        '',
        limit,
        { ...options, providerAccountId },
      )) ?? []
    ).some((row) => row.is_from_me);
  // All directions: the bot's own replies mark its thread, because some
  // providers store a live thread root without a thread id.
  const threadId = input.threadId;
  if (threadId && (await botSpokeIn(input.pageSize, { threadId }))) return true;
  for (const message of allowed) {
    if (
      message.reply_to_message_id &&
      (await botSpokeIn(1, {
        externalMessageId: message.reply_to_message_id,
      }))
    )
      return true;
  }
  return false;
}
