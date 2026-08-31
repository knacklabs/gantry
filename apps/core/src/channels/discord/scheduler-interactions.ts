// CARDFIX-1: Discord scheduler button interactions (run-now / pause /
// retry-and-ask) extracted from interactions.ts to keep it inside its line
// budget. Returns true when the customId was a scheduler action.
import {
  SCHEDULER_PAUSE_JOB_CUSTOM_ID_PREFIX,
  SCHEDULER_RETRY_ASK_CUSTOM_ID_PREFIX,
  SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX,
} from './components.js';
import type { MessageActionCallbackInput } from '../../domain/types.js';

const SCHEDULER_PREFIXES = [
  [
    SCHEDULER_RUN_NOW_CUSTOM_ID_PREFIX,
    'scheduler_run_now',
    'Checking retry request.',
  ],
  [SCHEDULER_PAUSE_JOB_CUSTOM_ID_PREFIX, 'scheduler_pause_job', 'Pausing job.'],
  [
    SCHEDULER_RETRY_ASK_CUSTOM_ID_PREFIX,
    'scheduler_retry_ask',
    'Resuming for one asking run.',
  ],
] as const;

export async function dispatchDiscordSchedulerInteraction(
  customId: string,
  userId: string | undefined,
  channelId: string,
  input: {
    opts: {
      providerAccountId?: string;
      onMessageAction?: (
        action: MessageActionCallbackInput,
      ) => Promise<unknown> | void;
    };
    resolveInteractionConversationContext: (
      channelId: string,
    ) => Promise<{ conversationJid: string; threadId?: string | null }>;
  },
  ack: (text: string) => Promise<unknown> | void,
): Promise<boolean> {
  const match = SCHEDULER_PREFIXES.find(([prefix]) =>
    customId.startsWith(prefix),
  );
  if (!match) return false;
  const [prefix, kind, ackText] = match;
  await ack(ackText);
  const context = await input.resolveInteractionConversationContext(channelId);
  await input.opts.onMessageAction?.({
    kind,
    conversationJid: context.conversationJid,
    providerAccountId: input.opts.providerAccountId,
    ...(context.threadId ? { threadId: context.threadId } : {}),
    userId,
    jobId: decodeURIComponent(customId.slice(prefix.length)),
  });
  return true;
}
