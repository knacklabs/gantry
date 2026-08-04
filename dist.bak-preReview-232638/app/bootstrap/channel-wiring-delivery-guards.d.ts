import type { RecoveryDispatchPermit, RecoveryDispatchPermitInput } from './channel-wiring-types.js';
export declare function sanitizeDeliveryError(err: unknown, provider: string): string;
export declare function createRecoveryDispatchPermit(input: RecoveryDispatchPermitInput): RecoveryDispatchPermit;
export declare function assertRecoveryDispatchPermit(permit: RecoveryDispatchPermit, input: {
    jid: string;
    rawText: string;
    threadId?: string;
}): void;
