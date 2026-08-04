export declare function resolveConversationBrowserProfile(input: {
    agentId?: string;
    workspaceKey?: string;
    conversationId?: string;
}): string;
export declare function formatBrowserProfileLabel(input: {
    agentName?: string;
    conversationKind?: 'dm' | 'channel';
}): string;
