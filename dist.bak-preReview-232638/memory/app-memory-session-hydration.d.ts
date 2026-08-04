import type { AgentSession } from '../domain/sessions/sessions.js';
type HydrationMode = 'first_visible' | 'full';
export declare function loadSessionAppMemoryItems(input: {
    session: AgentSession;
    limit: number;
    conversationKind?: string;
    query?: string;
    hydrationMode?: HydrationMode;
    statementTimeoutMs?: number;
}): Promise<Array<{
    id: string;
    kind: string;
    key: string;
    value: string;
    subject: Record<string, unknown>;
}>>;
export declare function loadBoundaryExtractionAppMemoryItems(input: {
    session: AgentSession;
    limit: number;
    defaultScope?: 'user' | 'group';
}): Promise<Array<{
    id: string;
    key: string;
    value: string;
}>>;
export {};
