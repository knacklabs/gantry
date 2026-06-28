import type { ProgressUpdateOptions } from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';

type SlackThreadStatusApp = {
  client: {
    apiCall(method: string, input: Record<string, unknown>): Promise<unknown>;
  };
};

function slackApiCallOk(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { ok?: unknown }).ok === true
  );
}

export function isSlackTerminalSuccessText(text: string): boolean {
  return text === 'Done.' || /^Done in\b/.test(text);
}

export async function sendSlackThreadProgressStatus(input: {
  app: SlackThreadStatusApp;
  channelId: string;
  threadTs: string;
  key: string;
  statusText: string;
  options: ProgressUpdateOptions;
}): Promise<boolean> {
  try {
    const result = await input.app.client.apiCall(
      'assistant.threads.setStatus',
      {
        channel_id: input.channelId,
        thread_ts: input.threadTs,
        status: input.statusText,
      },
    );
    if (!slackApiCallOk(result)) {
      logger.warn(
        {
          channelId: input.channelId,
          threadTs: input.threadTs,
          key: input.key,
          statusText: input.statusText,
          slackError:
            typeof result === 'object' && result !== null
              ? (result as { error?: unknown }).error
              : undefined,
        },
        'Progress lifecycle slack thread status failed',
      );
      return false;
    }
    logger.info(
      {
        channelId: input.channelId,
        threadTs: input.threadTs,
        key: input.key,
        statusText: input.statusText,
        done: input.options.done ?? false,
        replaceOnly: input.options.replaceOnly ?? false,
        generation: input.options.generation,
      },
      'Progress lifecycle slack thread status sent',
    );
    return true;
  } catch (err) {
    logger.warn(
      {
        channelId: input.channelId,
        threadTs: input.threadTs,
        key: input.key,
        statusText: input.statusText,
        err,
      },
      'Progress lifecycle slack thread status failed',
    );
    return false;
  }
}

export async function handleSlackThreadProgressStatus(input: {
  app: SlackThreadStatusApp;
  channelId: string;
  key: string;
  text: string;
  options: ProgressUpdateOptions;
  onDone: () => void;
}): Promise<boolean> {
  const threadTs = slackThreadTsFromThreadId(input.options.threadId);
  if (!threadTs) return false;
  const actionOnly = Boolean(
    input.options.actionOnly && input.options.actionAffordances?.length,
  );
  const trimmedText = input.text.trim();
  const clearingTerminalStatus = Boolean(
    input.options.done && isSlackTerminalSuccessText(trimmedText),
  );
  const statusText = clearingTerminalStatus
    ? ''
    : actionOnly
      ? 'Looking into it...'
      : trimmedText;
  if (!statusText && !clearingTerminalStatus) return false;
  const sent = await sendSlackThreadProgressStatus({
    ...input,
    threadTs,
    statusText,
  });
  if (!sent) return false;
  if (input.options.done) input.onDone();
  return true;
}
