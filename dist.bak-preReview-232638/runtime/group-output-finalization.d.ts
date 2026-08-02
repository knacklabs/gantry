import type { MessageSendOptions, NewMessage } from '../domain/types.js';
import type { DeliverySettlement } from '../jobs/delivery.js';
export declare function finalizeGroupAgentUserVisibleOutput(input: {
    streamedTranscriptDeliveryStatus: 'none' | 'sent' | 'partially_sent';
    boundedTranscript: string | null;
    chatJid: string;
    activeThreadId?: string;
    outputSentToUser: boolean;
    sawRawOutput: boolean;
    groupName: string;
    warn: (metadata: Record<string, unknown>, message: string) => void;
    storeMessage: (message: NewMessage) => Promise<unknown>;
    buildMessageOptions: () => MessageSendOptions | undefined | Promise<MessageSendOptions | undefined>;
    sendMessageToChannel: (text: string, options?: MessageSendOptions) => Promise<DeliverySettlement>;
}): Promise<{
    outputSentToUser: boolean;
    terminalSettlement: DeliverySettlement;
}>;
