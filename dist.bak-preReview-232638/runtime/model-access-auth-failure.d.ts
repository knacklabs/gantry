import type { MessageSendOptions } from '../domain/types.js';
import type { DeliverySettlement } from '../jobs/delivery.js';
export declare const MODEL_ACCESS_AUTH_FAILURE_MESSAGE = "Model Access authentication failed. Update the provider API key in Model Access, then send the message again.";
export declare function isModelAccessAuthFailure(error?: string): boolean;
export declare function sendModelAccessAuthFailureNotice(input: {
    chatJid: string;
    groupName: string;
    messageOptions?: MessageSendOptions;
    sendMessageToChannel: (text: string, options?: MessageSendOptions) => Promise<void | boolean>;
    warn: (metadata: Record<string, unknown>, message: string) => void;
}): Promise<DeliverySettlement>;
