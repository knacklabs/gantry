import type { MessageSendOptions, StreamingChunkOptions } from '../domain/types.js';
import { type DeliverySettlement } from '../jobs/delivery.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
type RuntimeLogger = {
    info(input: unknown, message: string): void;
    warn(input: unknown, message: string): void;
};
export declare function createGroupOutputBuffer(input: {
    channelRuntime: GroupProcessingDeps['channelRuntime'];
    chatJid: string;
    groupName: string;
    supportsStreamingChunks: boolean;
    buildStreamingOptions: (args: {
        done?: boolean;
    }) => StreamingChunkOptions;
    buildMessageOptions: () => MessageSendOptions | undefined | Promise<MessageSendOptions | undefined>;
    sendMessageToChannel: (text: string, options?: MessageSendOptions) => Promise<void>;
    applyDeliverySettlement: (settlement: DeliverySettlement, options: {
        streamed: boolean;
        terminal: boolean;
    }) => void;
    log: RuntimeLogger;
}): {
    appendRawOutput: (raw: string) => Promise<void>;
    flushBufferedOutput: (reason: string, options?: {
        done?: boolean;
        terminal?: boolean;
    }) => Promise<boolean>;
    transcriptSnapshot: () => string | null;
};
export {};
