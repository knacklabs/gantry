// CARDFIX-1: Telegram scheduler button callbacks (run-now / pause / retry-ask)
// extracted from callback-handlers.ts to keep that module inside its line
// budget. Type-only imports back into callback-handlers are erased at runtime.
import type {
  TelegramCallbackChannel,
  TelegramCallbackContext,
} from './callback-handlers.js';

export async function handleTelegramSchedulerCallback(
  channel: TelegramCallbackChannel,
  ctx: TelegramCallbackContext,
  compactRetryJobId: string,
  deadLetterActionMatch: RegExpExecArray | null,
  askRetryJobId = '',
): Promise<void> {
  // CARDFIX-1: pause cards carry real actions — 'a:<jobId>' (retry-and-ask)
  // resumes a setup-paused job for one asking run; dl:pause actually pauses.
  const dlVerb = deadLetterActionMatch?.[1];
  const rawJobId =
    compactRetryJobId ||
    askRetryJobId ||
    ((dlVerb === 'retry' || dlVerb === 'pause') && deadLetterActionMatch?.[2]
      ? deadLetterActionMatch[2]
      : '');
  if (rawJobId) {
    const kind = askRetryJobId
      ? ('scheduler_retry_ask' as const)
      : dlVerb === 'pause'
        ? ('scheduler_pause_job' as const)
        : ('scheduler_run_now' as const);
    let jobId: string;
    try {
      jobId = decodeURIComponent(rawJobId);
    } catch {
      await ctx.answer('Invalid scheduler action.', true);
      return;
    }
    if (!ctx.conversationJid) return;
    await channel.opts.onMessageAction?.({
      kind,
      conversationJid: ctx.conversationJid,
      ...(ctx.providerAccountId
        ? { providerAccountId: ctx.providerAccountId }
        : {}),
      threadId: ctx.threadId,
      userId: ctx.userId,
      jobId,
    });
    await ctx.answer(
      kind === 'scheduler_retry_ask'
        ? 'Resuming for one asking run.'
        : kind === 'scheduler_pause_job'
          ? 'Pausing job.'
          : 'Checking retry request.',
    );
    return;
  }
  await ctx.answer(
    'Open the scheduler surface or use scheduler tools to run this action.',
    true,
  );
}
