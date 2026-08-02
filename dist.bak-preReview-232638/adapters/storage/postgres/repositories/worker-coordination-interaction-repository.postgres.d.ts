import type { LiveTurnCommandAppendInput, LiveTurnCommandNotifier } from '../../../../domain/ports/live-turns.js';
import type { PendingInteraction, PendingInteractionKind, PermissionPromptGroup } from '../../../../domain/ports/worker-coordination.js';
import type { PermissionCallbackClaim, PermissionCallbackClaimReference, PermissionCallbackScope, PermissionRecoveryEnvelope } from '../../../../domain/types.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare abstract class PostgresInteractionRepositoryMethods {
    protected readonly db: CanonicalDb;
    private readonly commandNotifier?;
    protected constructor(db: CanonicalDb, commandNotifier?: LiveTurnCommandNotifier | undefined);
    createPendingInteraction(input: {
        id: string;
        appId: string;
        runId?: string | null;
        sourceAgentFolder: string;
        requestId: string;
        runLeaseToken?: string | null;
        runLeaseFencingVersion?: number | null;
        kind: PendingInteractionKind;
        payload: Record<string, unknown>;
        callbackRoute?: Record<string, unknown> | null;
        idempotencyKey: string;
        expiresAt: string;
        now?: string;
    }): Promise<PendingInteraction>;
    resolvePendingInteraction(input: {
        idempotencyKey: string;
        status: 'resolved' | 'cancelled';
        resolution: Record<string, unknown>;
        approverRef?: string | null;
        permissionCallbackClaim?: PermissionCallbackClaimReference | null;
        liveTurnCommand?: LiveTurnCommandAppendInput | null;
        now?: string;
    }): Promise<boolean>;
    cancelPendingQuestionInteractionIfRunLeaseInactive(input: {
        id: string;
        resolution: Record<string, unknown>;
        now?: string;
    }): Promise<boolean>;
    updatePendingInteractionPayload(input: {
        idempotencyKey: string;
        update: (payload: Record<string, unknown>) => Record<string, unknown> | null;
    }): Promise<boolean>;
    claimPendingPermissionCallback(input: {
        claim: PermissionCallbackClaim;
    }): Promise<PermissionPromptGroup | null>;
    bindPendingPermissionPrompt(input: {
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
        now?: string;
    }): Promise<PermissionPromptGroup | null>;
    releasePendingPermissionCallback(input: {
        claim: PermissionCallbackClaimReference;
    }): Promise<boolean>;
    settlePendingPermissionCallback(input: {
        claim: PermissionCallbackClaimReference;
    }): Promise<boolean>;
    expirePendingPermissionReviewEach(input: {
        claim: PermissionCallbackClaimReference;
        now?: string;
    }): Promise<PermissionPromptGroup | null>;
    findPendingPermissionPrompt(input: {
        scope: PermissionCallbackScope;
        now?: string;
        includeTerminalSettlement?: boolean;
    }): Promise<PermissionPromptGroup | null>;
    findPendingPermissionPromptByMember(input: {
        appId: string;
        sourceAgentFolder: string;
        requestId: string;
        now?: string;
    }): Promise<PermissionPromptGroup | null>;
    findPendingPermissionPromptByMessage(input: {
        appId: string;
        provider: string;
        conversationId: string;
        externalMessageId: string;
        threadId?: string | null;
        now?: string;
    }): Promise<PermissionPromptGroup | null>;
    findPendingInteractionByRequest(input: {
        appId: string;
        kind: PendingInteractionKind;
        sourceAgentFolder?: string;
        requestId: string;
        now?: string;
    }): Promise<PendingInteraction | null>;
    findPendingInteractionByIdempotencyKey(input: {
        appId: string;
        idempotencyKey: string;
        runId?: string | null;
        now?: string;
    }): Promise<PendingInteraction | null>;
    listPendingInteractions(input: {
        appId: string;
        runId?: string | null;
        now?: string;
    }): Promise<PendingInteraction[]>;
}
