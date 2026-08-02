import type { PermissionPromptGroup } from '../../../../domain/ports/worker-coordination.js';
import type { PermissionCallbackClaim, PermissionCallbackClaimReference, PermissionCallbackScope, PermissionRecoveryEnvelope } from '../../../../domain/types.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function bindPendingPermissionPromptRows(db: CanonicalDb, input: {
    id: string;
    appId: string;
    sourceAgentFolder: string;
    interactionId: string;
    matchKind: 'individual' | 'batch';
    members: Array<{
        idempotencyKey: string;
        requestId: string;
        index: number;
    }>;
    envelope: PermissionRecoveryEnvelope;
    fullView?: Record<string, unknown> | null;
    externalPromptProvider?: string | null;
    externalPromptConversationId?: string | null;
    externalPromptMessageId?: string | null;
    externalPromptThreadId?: string | null;
    providerAliases: string[];
    now: string;
}): Promise<PermissionPromptGroup | null>;
export declare function claimPendingPermissionCallbackRows(db: CanonicalDb, input: {
    claim: PermissionCallbackClaim;
}): Promise<PermissionPromptGroup | null>;
export declare function releasePendingPermissionCallbackRows(db: CanonicalDb, input: {
    claim: PermissionCallbackClaimReference;
    now: string;
}): Promise<boolean>;
export declare function settlePendingPermissionCallbackRows(db: CanonicalDb, input: {
    claim: PermissionCallbackClaimReference;
    now: string;
}): Promise<boolean>;
export declare function expirePendingPermissionReviewEachRows(db: CanonicalDb, input: {
    claim: PermissionCallbackClaimReference;
    now: string;
}): Promise<PermissionPromptGroup | null>;
export declare function findPendingPermissionPromptRow(db: CanonicalDb, input: {
    scope: PermissionCallbackScope;
    now: string;
    includeTerminalSettlement?: boolean;
}): Promise<PermissionPromptGroup | null>;
export declare function findPendingPermissionPromptByMemberRow(db: CanonicalDb, input: {
    appId: string;
    sourceAgentFolder: string;
    requestId: string;
    now: string;
}): Promise<PermissionPromptGroup | null>;
export declare function findPendingPermissionPromptByMessageRow(db: CanonicalDb, input: {
    appId: string;
    provider: string;
    conversationId: string;
    externalMessageId: string;
    threadId?: string | null;
    now: string;
}): Promise<PermissionPromptGroup | null>;
