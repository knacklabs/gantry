export type ContinuitySectionName = 'recent_session_digests' | 'top_scoped_memories' | 'recent_decisions' | 'active_paused_jobs';
export type ContinuitySectionStatus = 'populated' | 'empty' | 'unavailable' | 'deferred';
export interface SessionContinuityInjectionSubject {
    appId: string;
    agentId: string;
    conversationId?: string;
    userId?: string;
    threadId?: string;
}
export interface SessionContinuityInjectionStatus {
    injectedAt: string;
    hydrationMode?: 'first_visible' | 'full';
    subject: SessionContinuityInjectionSubject;
    bytes: number;
    maxBytes: number;
    truncated: boolean;
    blockEmpty: boolean;
    sections: Record<ContinuitySectionName, {
        status: ContinuitySectionStatus;
        count: number;
        items?: unknown[];
    }>;
}
export declare function recordSessionContinuityInjectionStatus(status: SessionContinuityInjectionStatus): void;
export declare function getLastSessionContinuityInjectionStatus(subject: Partial<SessionContinuityInjectionSubject>): SessionContinuityInjectionStatus | undefined;
export declare function clearSessionContinuityInjectionStatusForTests(): void;
