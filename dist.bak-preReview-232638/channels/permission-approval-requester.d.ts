import type { PermissionApprovalCancellation, PermissionApprovalDecision, PermissionApprovalRequest } from '../domain/types.js';
type ChannelLike = object;
interface PermissionApprovalSurfaceLike {
    requestPermissionApproval: (targetJid: string, request: PermissionApprovalRequest, onPromptDelivered?: (messageId: string) => void) => Promise<PermissionApprovalDecision>;
    dropPendingInteraction?: (kind: 'permission' | 'question', request: PermissionApprovalRequest) => void;
    cancelPendingPermission?: (request: PermissionApprovalCancellation) => Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
}
export interface PermissionApprovalRequester {
    (request: PermissionApprovalRequest): Promise<PermissionApprovalDecision>;
    cancel(cancellation: PermissionApprovalCancellation): Promise<'settled' | 'queued' | 'not_found'>;
}
export declare function createPermissionApprovalRequester(input: {
    findBoundChannel: (jid: string, providerAccountId?: string, request?: PermissionApprovalRequest) => ChannelLike | undefined;
    asPermissionApprovalSurface: (channel: ChannelLike) => PermissionApprovalSurfaceLike | undefined;
    interactionLifecycle: {
        logger: {
            error: (dataOrMsg: string | Record<string, unknown>, msg?: string) => void;
        };
        resetStreaming?: (jid: string, options?: {
            providerAccountId?: string;
            threadId?: string;
        }) => void;
    };
}): PermissionApprovalRequester;
export {};
