import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export declare const RESUMABLE_PROVIDER_SESSION_STATUSES: string[];
export type ProviderSessionMaintenanceInput = {
    providerSessionId: string;
    agentSessionId: string;
    provider: string;
    externalSessionId: string;
    compactionBaseCursor?: string | null;
};
export type ProviderSessionMaintenanceFinishInput = ProviderSessionMaintenanceInput & {
    status: 'active' | 'expired' | 'ready';
};
export declare function escapeLikePattern(value: string): string;
export declare function makeOwnedAgentSessionScopeKey(agentId: string, routeScopeKey: string, appId?: string): string;
export declare function makeOwnedAgentSessionId(agentId: string, routeScopeKey: string, appId?: string): string;
export declare function buildCurrentScopeResetMatcher(scopeKey: string): {
    currentScopeExact: string;
    currentScopeDescendantLike?: string;
};
export declare function conversationKindInput(kind?: 'dm' | 'channel'): {
    isGroup?: boolean;
};
export declare function providerSessionContext(providerSession: {
    id: string;
    externalSessionId: string;
    metadataJson: unknown;
    status?: string;
}): {
    providerSessionId?: string;
    externalSessionId?: string;
    latestProviderSessionLocked?: boolean;
    lockedProviderSessionId?: string;
    latestProviderSessionReady?: boolean;
    readyProviderSessionId?: string;
    readyExternalSessionId?: string;
    providerSessionAccessFingerprint?: string;
    compactionDeltaReplay?: {
        status: 'pending' | 'applied' | 'degraded';
        baseCursor?: string;
        lockedAt?: string;
    };
};
export declare function isProviderSessionMaintenanceLocked(executor: CanonicalExecutor, id: string): Promise<boolean>;
export declare function releaseStaleProviderSessionMaintenanceLocks(executor: CanonicalExecutor, input: {
    providerSessionId?: string;
    agentSessionId?: string;
    provider?: string;
}): Promise<void>;
export declare function markLatestProviderSessionMaintenance(executor: CanonicalExecutor, input: ProviderSessionMaintenanceInput): Promise<boolean>;
export declare function finishProviderSessionMaintenance(executor: CanonicalExecutor, input: ProviderSessionMaintenanceFinishInput): Promise<void>;
export declare function promoteReadyProviderSession(executor: CanonicalExecutor, input: ProviderSessionMaintenanceInput): Promise<boolean>;
export declare function markProviderSessionDeltaReplay(executor: CanonicalExecutor, input: ProviderSessionMaintenanceInput & {
    status: 'applied' | 'degraded';
    reason?: string;
}): Promise<void>;
export declare function promoteLatestReadyProviderSession(executor: CanonicalExecutor, input: {
    agentSessionId: string;
    provider: string;
}): Promise<boolean>;
export declare function expireProviderSession(executor: CanonicalExecutor, input: ProviderSessionMaintenanceInput): Promise<void>;
export declare function findControlSessionForChatJid(executor: CanonicalExecutor, appId: string, chatJid: string): Promise<{
    agentId: string;
    conversationId: string;
} | undefined>;
export declare function resolveSessionAppId(input: {
    appId?: string | null;
    chatJid?: string | null;
}): string;
