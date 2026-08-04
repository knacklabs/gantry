import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { NewMessage } from '../../domain/types.js';
type ConversationOutboundEventLogger = {
    warn(context: Record<string, unknown>, message: string): void;
};
type ConversationOutboundDeliveryStatus = 'sent' | 'failed' | 'partially_sent';
export declare function createConversationOutboundProjection(input: {
    rawText: string;
    channelName: string;
    providerId: string;
    providerAccountId?: string;
    conversationJid: string;
    threadId?: string;
    appId: AppId;
    publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<unknown>;
    logger: ConversationOutboundEventLogger;
}): {
    formatted: string;
    provider: string;
    messageId: string;
    baseMessage: NewMessage;
    publishEvent(input: {
        deliveryStatus: ConversationOutboundDeliveryStatus;
        externalMessageId?: string;
        error?: string;
    }): Promise<void>;
} | undefined;
export {};
