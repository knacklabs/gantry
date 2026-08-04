import type { ConversationRoute, NewMessage } from '../domain/types.js';
export declare function groupTurnHasRequiredTrigger(input: {
    group: ConversationRoute;
    chatJid: string;
    triggerPattern: RegExp;
    messages: NewMessage[];
}): boolean;
