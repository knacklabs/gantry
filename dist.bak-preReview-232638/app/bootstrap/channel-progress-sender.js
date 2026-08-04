import { asProgressSink } from './channel-capability-ports.js';
export function createChannelProgressSender(input) {
    return async function sendProgressUpdate(jid, text, options) {
        input.messageActionRouter.trackProgress(jid, options);
        const channel = input.findBoundChannel(jid, options?.providerAccountId);
        if (!channel) {
            input.logger.info({ jid, progressText: text, options }, 'Progress lifecycle channel-wiring skipped without channel');
            return;
        }
        const sink = asProgressSink(channel);
        if (!sink) {
            input.logger.info({ jid, progressText: text, options }, 'Progress lifecycle channel-wiring skipped without progress sink');
            return;
        }
        input.logger.info({ jid, progressText: text, options }, 'Progress lifecycle channel-wiring send attempt');
        await sink.sendProgressUpdate(jid, text, options);
        input.logger.info({ jid, progressText: text, options }, 'Progress lifecycle channel-wiring send complete');
    };
}
