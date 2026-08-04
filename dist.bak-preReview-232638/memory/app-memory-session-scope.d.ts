import type { AgentSession } from '../domain/sessions/sessions.js';
export declare function parseSessionScopeKey(input: {
    session: AgentSession;
}): {
    isScopeKey: boolean;
    groupId?: string;
};
export declare function conversationJidFromSession(session: AgentSession): string | undefined;
