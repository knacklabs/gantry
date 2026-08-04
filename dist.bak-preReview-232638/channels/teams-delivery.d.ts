import type { MessageDeliveryResult, MessageSendOptions } from '../domain/types.js';
import type { TeamsSdkClient } from './teams.js';
export declare const TEAMS_HARD_MESSAGE_BYTES: number;
export declare function splitTeamsTextByByteBudget(text: string, maxBytes: number): string[];
export declare function sendTeamsTextMessage(sdkClient: TeamsSdkClient, conversationId: string, text: string, options?: MessageSendOptions, shouldContinue?: () => boolean): Promise<MessageDeliveryResult | void>;
