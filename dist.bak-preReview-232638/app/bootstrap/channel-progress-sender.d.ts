import type { ProgressUpdateOptions } from '../../domain/types.js';
import type { logger } from '../../infrastructure/logging/logger.js';
import { asProgressSink } from './channel-capability-ports.js';
import type { createChannelMessageActionRouter } from './channel-message-action-router.js';
type ProgressChannel = Parameters<typeof asProgressSink>[0];
export declare function createChannelProgressSender(input: {
    findBoundChannel: (jid: string, providerAccountId?: string) => ProgressChannel | undefined;
    messageActionRouter: ReturnType<typeof createChannelMessageActionRouter>;
    logger: Pick<typeof logger, 'info'>;
}): (jid: string, text: string, options?: ProgressUpdateOptions) => Promise<void>;
export {};
