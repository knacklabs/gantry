import type { IpcDeps } from '../runtime/ipc-domain-types.js';
export interface RequestPermissionLocalCliReview {
    toolName: string;
    toolInput: Record<string, unknown>;
}
export declare function jobLocalCliCapabilityConflict(input: {
    deps: Pick<IpcDeps, 'opsRepository'>;
    jobId?: string;
    review: RequestPermissionLocalCliReview;
}): Promise<string | null>;
