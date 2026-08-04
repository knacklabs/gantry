import type { ConversationRoute } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
export declare function resolveGroupProcessingRouteContext(deps: GroupProcessingDeps, queueJid: string): {
    chatJid: string;
    threadId?: string;
    agentId?: string;
    routeKey: string;
    turnAppId: string;
    group: ConversationRoute;
    commandOverrideRouteKey: string;
} | null;
export declare function resolveCommandOverrideRouteKey(input: {
    chatJid: string;
    threadId?: string;
    providerAccountId?: string;
    queueAgentId?: string;
    agentFolder: string;
    registeredJids: Set<string>;
    routeKey: string;
}): string;
