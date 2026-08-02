import type { UserQuestionCancellation } from '../domain/types.js';
import {
  RUNNER_CANCELLED_QUESTION_REASON,
  matchesQuestionCancellation,
  settlePendingQuestionCancellation,
  type InteractionCancellationResult,
} from './interaction-settlement.js';
import {
  DISCORD_API_ROOT,
  discordHeaders,
} from './discord-interaction-helpers.js';
import type { PendingDiscordQuestion } from './discord-user-question-delivery.js';

export async function cancelPendingDiscordQuestion(
  pendingQuestionMap: Map<string, PendingDiscordQuestion>,
  botToken: string,
  cancellation: UserQuestionCancellation,
): Promise<InteractionCancellationResult> {
  const pendingQuestions = [...new Set(pendingQuestionMap.values())].filter(
    (pending) => matchesQuestionCancellation(pending.request, cancellation),
  );
  if (pendingQuestions.length === 0) return 'not_found';
  const settled = await settlePendingQuestionCancellation(cancellation);
  if (settled !== 'settled') return settled;
  const reason = cancellation.reason ?? RUNNER_CANCELLED_QUESTION_REASON;
  for (const pending of pendingQuestions) {
    clearTimeout(pending.timeout);
    for (const callback of pending.callbacks) {
      pendingQuestionMap.delete(callback.providerAlias);
    }
    pending.resolve({
      requestId: pending.request.requestId,
      answers: {},
    });
    for (const messageId of pending.messageIds) {
      try {
        await fetch(
          `${DISCORD_API_ROOT}/channels/${encodeURIComponent(pending.channelId)}/messages/${encodeURIComponent(messageId)}`,
          {
            method: 'PATCH',
            headers: discordHeaders(botToken),
            body: JSON.stringify({ content: reason, components: [] }),
          },
        );
      } catch {
        // The durable cancellation and removed callbacks remain authoritative.
      }
    }
  }
  return 'settled';
}
