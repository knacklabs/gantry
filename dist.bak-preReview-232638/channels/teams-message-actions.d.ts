import type { OnMessageAction } from '../domain/types.js';
import type { TeamsInboundMessage } from './teams-types.js';
export declare function readTeamsMessageAction(value: unknown): {
    kind: 'live_turn_stop';
    actionToken: string;
    targetJid: string;
    threadId?: string;
} | {
    kind: 'scheduler_run_now';
    jobId: string;
    targetJid: string;
    threadId?: string;
} | null;
export declare function handleTeamsMessageAction(input: {
    message: TeamsInboundMessage;
    jid: string;
    userId: string;
    providerAccountId?: string;
    onMessageAction?: OnMessageAction;
    sendDenied: (conversationId: string | null, text: string) => Promise<void>;
}): Promise<boolean>;
