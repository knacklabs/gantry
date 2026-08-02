import type { PendingInteractionKind } from '../../domain/ports/worker-coordination.js';
export declare function pendingInteractionIdempotencyKey(input: {
    kind: PendingInteractionKind;
    sourceAgentFolder: string;
    requestId: string;
    appId?: string | null;
}): string;
