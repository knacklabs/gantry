export declare function responseSigningKeyId(publicKeyPem: string): string;
export declare function computeIpcAuthToken(workspaceKey: string, threadId?: string | null, scope?: {
    appId?: string | null;
    agentId?: string | null;
}): string;
export declare function computeBrowserIpcAuthToken(workspaceKey: string, chatJid: string, threadId?: string | null): string;
export declare function registerBrowserIpcAuthorization(input: {
    workspaceKey: string;
    chatJid: string;
    threadId?: string | null;
}): void;
export declare function revokeBrowserIpcAuthorization(input: {
    workspaceKey: string;
    chatJid: string;
    threadId?: string | null;
}): void;
export declare function isBrowserIpcAuthorized(input: {
    workspaceKey: string;
    chatJid: string;
    threadId?: string | null;
}): boolean;
export declare function computeMemoryIpcAuthToken(workspaceKey: string, input: {
    chatJid?: string | null;
    userId?: string | null;
    defaultScope?: 'user' | 'group' | null;
    threadId?: string | null;
    allowedActions?: readonly string[] | null;
    reviewerIsControlApprover?: boolean | null;
}): string;
export declare function validateIpcAuthToken(workspaceKey: string, candidateToken: string, threadId?: string | null, scope?: {
    appId?: string | null;
    agentId?: string | null;
}): boolean;
export declare function createIpcAuthEnvelope(workspaceKey: string, threadId?: string | null, scope?: {
    appId?: string | null;
    agentId?: string | null;
}): {
    authToken: string;
    responseVerifyKey: string;
    responseKeyId: string;
};
export declare function getIpcResponseSigningPrivateKey(workspaceKey: string, threadId?: string | null, responseKeyId?: string | null): string | undefined;
export declare function sealIpcResponseSigningPrivateKey(privateKeyPem: string | undefined): string | undefined;
export declare function unsealIpcResponseSigningPrivateKey(sealed: string | undefined): string | undefined;
export declare function revokeIpcResponseSigningKey(responseKeyId: string | undefined, workspaceKey: string, threadId?: string | null): boolean;
