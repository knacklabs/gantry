import type { MessageDeliveryResult, MessageSendOptions, ProgressUpdateOptions } from '../domain/types.js';
import type { TeamsSdkClient } from './teams-types.js';
export type TeamsProgressMessages = Map<string, {
    conversationId: string;
    messageId?: string;
}>;
export declare function sendTeamsTextOrActionMessage(input: {
    sdkClient: TeamsSdkClient;
    jid: string;
    text: string;
    options?: MessageSendOptions;
}): Promise<MessageDeliveryResult | void>;
export declare function sendTeamsProgressUpdate(input: {
    sdkClient: TeamsSdkClient;
    pendingProgress: TeamsProgressMessages;
    jid: string;
    text: string;
    options?: ProgressUpdateOptions;
}): Promise<void>;
