import type { PendingInteraction, PendingInteractionKind } from '../../../../domain/ports/worker-coordination.js';
import type { LiveTurnCommand, LiveTurnCommandAppendInput } from '../../../../domain/ports/live-turns.js';
import type { PermissionCallbackClaimReference } from '../../../../domain/types.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
type PendingInteractionRow = typeof pgSchema.pendingInteractionsPostgres.$inferSelect;
export declare function toPendingInteraction(row: PendingInteractionRow): PendingInteraction;
export declare function createPendingInteractionRow(db: CanonicalDb, input: {
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
    now: string;
}): Promise<PendingInteraction>;
export declare function resolvePendingInteractionRow(db: CanonicalDb, input: {
    idempotencyKey: string;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim?: PermissionCallbackClaimReference | null;
    liveTurnCommand?: LiveTurnCommandAppendInput | null;
    now: string;
}): Promise<{
    resolved: boolean;
    command: LiveTurnCommand | null;
}>;
export declare function cancelPendingQuestionInteractionIfRunLeaseInactiveRow(db: CanonicalDb, input: {
    id: string;
    resolution: Record<string, unknown>;
    now: string;
}): Promise<boolean>;
export declare function updatePendingInteractionPayloadRow(db: CanonicalDb, input: {
    idempotencyKey: string;
    update: (payload: Record<string, unknown>) => Record<string, unknown> | null;
}): Promise<boolean>;
export declare function findPendingInteractionByRequestRow(db: CanonicalDb, input: {
    appId: string;
    kind: PendingInteractionKind;
    sourceAgentFolder?: string;
    requestId: string;
    now: string;
}): Promise<PendingInteraction | null>;
export declare function findPendingInteractionByIdempotencyKeyRow(db: CanonicalDb, input: {
    appId: string;
    idempotencyKey: string;
    runId?: string | null;
    now: string;
}): Promise<PendingInteraction | null>;
export {};
