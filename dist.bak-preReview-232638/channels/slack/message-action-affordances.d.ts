import type { MessageActionAffordance } from '../../domain/types.js';
export declare function slackMessageActionBlocks(text: string, actions?: MessageActionAffordance[], options?: {
    actionOnly?: boolean;
    providerAccountId?: string;
}): Array<Record<string, unknown>> | undefined;
