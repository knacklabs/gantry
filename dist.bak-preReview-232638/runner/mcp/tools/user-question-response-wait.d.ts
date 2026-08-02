import { type IpcRequestClaimProbe } from '../../../shared/ipc-interaction-lifetime.js';
export declare const USER_QUESTION_TIMEOUT_MS: number;
export declare const USER_QUESTION_POLL_INTERVAL_MS = 100;
type UserQuestionToolResult = {
    content: Array<{
        type: 'text';
        text: string;
    }>;
};
export declare function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<boolean>;
export declare function waitForUserQuestionResponse(input: {
    requestId: string;
    requestPath: string;
    responsePath: string;
    permissionLane: 'autonomous' | 'interactive';
    authExpiresAt: unknown;
    signal?: AbortSignal;
    claimProbe?: IpcRequestClaimProbe;
}): Promise<UserQuestionToolResult>;
export {};
