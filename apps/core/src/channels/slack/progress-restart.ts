import { randomUUID } from 'node:crypto';

import type { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';
import type { ActiveProgressState } from './channel-state.js';

export const slackProgressBootNonce = randomUUID();

export function rejectOlderSlackProgressGeneration(
  input: {
    channelId: string;
    key: string;
    options: { done?: boolean; replaceOnly?: boolean; generation?: number };
  },
  state: ActiveProgressState | undefined,
): boolean {
  if (
    input.options.generation === undefined ||
    state?.generation === undefined ||
    input.options.generation >= state.generation
  ) {
    return false;
  }
  logger.info(
    {
      channelId: input.channelId,
      key: input.key,
      done: input.options.done ?? false,
      replaceOnly: input.options.replaceOnly ?? false,
      generation: input.options.generation,
      existingGeneration: state.generation,
    },
    'Progress lifecycle slack dropped generation mismatch',
  );
  return true;
}

export async function currentProcessSlackProgress(
  input: {
    app: App | null;
    key: string;
    options: { replaceOnly?: boolean };
    activeProgress: Map<string, ActiveProgressState>;
    persistProgress(): void;
  },
  state: ActiveProgressState | undefined,
): Promise<ActiveProgressState | undefined> {
  if (!state) return undefined;
  if (
    input.options.replaceOnly ||
    state.ownerBootNonce === slackProgressBootNonce
  ) {
    return state;
  }
  if (state.messageTs && input.app) {
    await input.app.client.chat
      .update({
        channel: state.channelId,
        ts: state.messageTs,
        text: 'Interrupted by a restart.',
        blocks: [],
      })
      .catch((err) => {
        logger.warn(
          {
            channelId: state.channelId,
            key: input.key,
            messageTs: state.messageTs,
            err,
          },
          'Progress lifecycle slack failed to mark prior-process card stale',
        );
      });
  }
  input.activeProgress.delete(input.key);
  input.persistProgress();
  return undefined;
}
