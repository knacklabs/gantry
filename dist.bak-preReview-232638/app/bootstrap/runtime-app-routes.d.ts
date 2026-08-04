import type { ConversationRoute } from '../../domain/types.js';
export declare function resolveConversationRoute(routes: Record<string, ConversationRoute>, chatJid: string, threadId?: string | null, agentId?: string | null, providerAccountId?: string | null, conversationId?: string | null): ConversationRoute | undefined;
