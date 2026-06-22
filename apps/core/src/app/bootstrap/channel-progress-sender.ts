import type { ProgressUpdateOptions } from '../../domain/types.js';
import type { logger } from '../../infrastructure/logging/logger.js';
import { asProgressSink } from './channel-capability-ports.js';
import type { createChannelMessageActionRouter } from './channel-message-action-router.js';

type ProgressChannel = Parameters<typeof asProgressSink>[0];

export function createChannelProgressSender(input: {
  findBoundChannel: (jid: string) => ProgressChannel | undefined;
  messageActionRouter: ReturnType<typeof createChannelMessageActionRouter>;
  logger: Pick<typeof logger, 'info'>;
}) {
  return async function sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void> {
    input.messageActionRouter.trackProgress(jid, options);
    const channel = input.findBoundChannel(jid);
    if (!channel) {
      input.logger.info(
        { jid, progressText: text, options },
        'Progress lifecycle channel-wiring skipped without channel',
      );
      return;
    }
    const sink = asProgressSink(channel);
    if (!sink) {
      input.logger.info(
        { jid, progressText: text, options },
        'Progress lifecycle channel-wiring skipped without progress sink',
      );
      return;
    }
    input.logger.info(
      { jid, progressText: text, options },
      'Progress lifecycle channel-wiring send attempt',
    );
    await sink.sendProgressUpdate(jid, text, options);
    input.logger.info(
      { jid, progressText: text, options },
      'Progress lifecycle channel-wiring send complete',
    );
  };
}
