export interface ProactiveSurfacingSubject {
    appId: string;
    agentId: string;
    subjectType: string;
    subjectId: string;
}
export interface ProactiveSurfacingOptIn {
    id: string;
    appId: string;
    agentId: string;
    subjectType: string;
    subjectId: string;
    conversationJid: string | null;
    proactiveSurfacingEnabled: boolean;
    enabledAt: string | null;
    optedOutAt: string | null;
    enabledByActorId: string | null;
    optedOutByActorId: string | null;
    createdAt: string;
    updatedAt: string;
}
