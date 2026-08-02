export type SessionRoute = {
    sessionId: string;
    action: 'get' | 'messages' | 'events' | 'wait' | 'runs' | 'interactions';
} | {
    sessionId: string;
    action: 'interaction-respond';
    interactionId: string;
};
export type JobRoute = {
    jobId: string;
    action: 'pause' | 'resume' | 'trigger';
} | {
    jobId: string;
    action: 'get' | 'delete' | 'update' | 'events';
};
export type WebhookRoute = {
    webhookId: string;
    action: 'delete' | 'test' | 'replay-dead-letter' | 'purge-dead-letter';
};
export type ProviderAccountRoute = {
    providerAccountId: string;
    action: 'get' | 'discover';
};
export type ConversationRoute = {
    conversationId: string;
    action: 'get' | 'threads' | 'messages';
};
export type ConversationInstallRoute = {
    agentId: string;
    conversationId?: string;
    action: 'list' | 'install';
};
export declare function parseSessionRoute(pathname: string): SessionRoute | null;
export declare function parseJobRoute(pathname: string): JobRoute | null;
export declare function parseTriggerWaitRoute(pathname: string): string | null;
export declare function parseRunRoute(pathname: string): string | null;
export declare function parseRunEventsRoute(pathname: string): string | null;
export declare function parseWebhookRoute(pathname: string): WebhookRoute | null;
export declare function parseProviderAccountRoute(pathname: string): ProviderAccountRoute | null;
export declare function parseConversationRoute(pathname: string): ConversationRoute | null;
export declare function parseConversationInstallRoute(pathname: string): ConversationInstallRoute | null;
