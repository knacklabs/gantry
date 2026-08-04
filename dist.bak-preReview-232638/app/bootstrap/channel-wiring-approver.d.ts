import type { ConversationRoute, PermissionApprovalRequest } from '../../domain/types.js';
import type { ChannelWiringDeps } from './channel-wiring-types.js';
export declare function authorizeConversationApprover(input: {
    providerId: string;
    sourceAgentFolder: string;
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
    logger: ChannelWiringDeps['logger'];
    lookup: () => Promise<boolean>;
}): Promise<boolean>;
export declare function resolveControlApproverContext(input: {
    routes: Record<string, ConversationRoute>;
    providerAccountId?: string;
    conversationJid: string;
    threadId?: string;
    sourceAgentFolder: string;
    agentId?: string;
}): {
    providerAccountId: string;
    agentId: string;
} | undefined;
export declare function resolveInputControlApproverContext(input: {
    routes: Record<string, ConversationRoute>;
    providerAccountId?: string;
    conversationJid: string;
    threadId?: string;
    sourceAgentFolder: string;
    agentId?: string;
}): {
    providerAccountId: string;
    agentId: string;
} | undefined;
