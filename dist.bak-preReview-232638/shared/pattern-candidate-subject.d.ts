export interface PatternSubjectScope {
    appId: string;
    agentId: string;
    folder: string;
    conversationId?: string;
    conversationKind?: 'dm' | 'channel';
    userId?: string;
}
export interface PatternSubjectTuple {
    appId: string;
    agentId: string;
    folder: string;
    subjectType: 'user' | 'channel' | 'group';
    subjectId: string;
}
export declare function canonicalConversationIdForPattern(value: string | undefined): string | undefined;
export declare function patternSubjectForScope(scope: PatternSubjectScope): PatternSubjectTuple | null;
