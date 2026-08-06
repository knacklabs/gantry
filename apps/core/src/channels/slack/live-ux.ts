import { LiveUxRateLimitError } from '../../domain/channel-live-ux.js';
import { slackRateLimitRetryDelayMs } from './channel-retry-delay.js';

export function slackReactionName(emoji: string): string {
  if (emoji === 'seen') return 'eyes';
  if (emoji === 'running') return 'hourglass_flowing_sand';
  return emoji.replace(/^:+|:+$/g, '');
}

export const SLACK_LIVE_UX_CAPABILITY = {
  typing: 'none',
  reactions: { removal: 'exact' },
  canonicalTarget: (
    target:
      | { operation: 'typing'; jid: string }
      | {
          operation: 'reaction';
          jid: string;
          messageRef: string;
          emoji: string;
        },
  ) => ({
    key:
      target.operation === 'typing'
        ? `typing\n${target.jid}`
        : `reaction\n${target.jid}\n${target.messageRef}\n${slackReactionName(target.emoji)}`,
  }),
} as const;

export class SlackLiveUxResponseError extends Error {
  readonly name = 'SlackLiveUxResponseError';

  constructor(readonly code: string) {
    super(`Slack live UX request failed: ${code}`);
  }
}

export async function requestSlackLiveUx(input: {
  method: 'reactions.add' | 'reactions.remove';
  botToken: string;
  channelId: string;
  messageRef: string;
  name: string;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(`https://slack.com/api/${input.method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.botToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      channel: input.channelId,
      timestamp: input.messageRef,
      name: input.name,
    }),
    signal: input.signal,
  });
  if (response.status === 429) {
    const retryDelayMs = slackRateLimitRetryDelayMs({
      status: response.status,
      retry_after: response.headers.get('retry-after'),
    });
    throw new LiveUxRateLimitError(retryDelayMs ?? 1_000, response);
  }
  if (!response.ok) {
    throw new Error(`Slack live UX HTTP request failed: ${response.status}`);
  }
  const result = (await response.json()) as { ok?: boolean; error?: string };
  if (!result.ok) {
    throw new SlackLiveUxResponseError(result.error ?? 'unknown_error');
  }
}
