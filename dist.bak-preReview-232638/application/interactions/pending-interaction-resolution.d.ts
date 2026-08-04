import type { PendingInteractionKind, PendingInteractionRepository } from '../../domain/ports/worker-coordination.js';
import type { LiveTurnRepository } from '../../domain/ports/live-turns.js';
import type { PermissionCallbackClaimReference } from '../../domain/types.js';
type InteractionLiveTurnRepository = Pick<LiveTurnRepository, 'findActiveLiveTurnByRunId'>;
export interface PendingInteractionResolutionBackend {
    repository: Pick<PendingInteractionRepository, 'findPendingInteractionByIdempotencyKey' | 'resolvePendingInteraction'>;
    liveTurns?: InteractionLiveTurnRepository | null;
    warn?: (context: Record<string, unknown>, message: string) => void;
}
export interface PendingInteractionResolutionInput {
    kind: PendingInteractionKind;
    sourceAgentFolder: string;
    requestId: string;
    idempotencyKey: string;
    appId: string;
    runId?: string | null;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim?: PermissionCallbackClaimReference | null;
}
export type PendingInteractionResolutionOutcome = 'resolved' | 'rejected' | 'retryable_error';
export declare function persistPendingInteractionResolution(active: PendingInteractionResolutionBackend, input: PendingInteractionResolutionInput): Promise<PendingInteractionResolutionOutcome>;
export {};
