export type Scope = 'sessions:read' | 'sessions:write' | 'approvals:write' | 'jobs:read' | 'jobs:write' | 'providers:read' | 'providers:admin' | 'conversations:read' | 'conversations:admin' | 'messages:read' | 'agents:admin' | 'credentials:read' | 'credentials:admin' | 'skills:read' | 'skills:admin' | 'mcp:read' | 'mcp:admin' | 'webhooks:read' | 'webhooks:write' | 'ingresses:read' | 'ingresses:write' | 'usage:read' | 'llm:invoke' | 'memory:read' | 'memory:admin';
export type ApiKeyRecord = {
    kid: string;
    tokenHash: Buffer;
    scopes: Set<Scope>;
    appId: string;
    maxTokens?: number;
};
export declare const CONTROL_API_SCOPES: readonly Scope[];
export declare function parseControlApiKeys(input: {
    rawJson?: string;
}): ApiKeyRecord[];
export declare function parseControlApiKeysStrict(input: {
    rawJson?: string;
    requireStrongTokens?: boolean;
    requireNonEmptyScopes?: boolean;
}): ApiKeyRecord[];
