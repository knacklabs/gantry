import type { ProgressUpdateOptions } from '../../domain/types.js';
import type { logger } from '../../infrastructure/logging/logger.js';
import { asProgressSink } from './channel-capability-ports.js';
import type { createChannelMessageActionRouter } from './channel-message-action-router.js';

type ProgressChannel = Parameters<typeof asProgressSink>[0];

export function createChannelProgressSender(input: {
  findBoundChannel: (
    jid: string,
    providerAccountId?: string,
  ) => ProgressChannel | undefined;
  messageActionRouter: ReturnType<typeof createChannelMessageActionRouter>;
  logger: Pick<typeof logger, 'info'>;
}) {
  return async function sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<boolean> {
    input.messageActionRouter.trackProgress(jid, options);
    const channel = input.findBoundChannel(jid, options?.providerAccountId);
    if (!channel) {
      input.logger.info(
        { jid, progressText: text, options },
        'Progress lifecycle channel-wiring skipped without channel',
      );
      return false;
    }
    const sink = asProgressSink(channel);
    if (!sink) {
      input.logger.info(
        { jid, progressText: text, options },
        'Progress lifecycle channel-wiring skipped without progress sink',
      );
      return false;
    }
    input.logger.info(
      { jid, progressText: text, options },
      'Progress lifecycle channel-wiring send attempt',
    );
    const landed = await sink
      .sendProgressUpdate(jid, text, options)
      .catch((err: unknown) => {
        input.logger.info(
          { err, jid, progressText: text, options },
          'Progress lifecycle channel-wiring send failed',
        );
        return false;
      });
    input.logger.info(
      { jid, progressText: text, options },
      'Progress lifecycle channel-wiring send complete',
    );
    return landed !== false;
  };
}
