import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../../domain/types.js';
import type { PausedJobCapabilityRecheckResult } from '../jobs/job-permission-recovery.js';
import { type PermissionPersistenceBackend } from './pending-interaction-permission-recovery.js';
export interface PermissionInteractionDecisionInput {
    request: PermissionApprovalRequest | null;
    sourceAgentFolder: string;
    decision: PermissionApprovalDecision;
    appId?: string | null;
    runId?: string | null;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    toolName: string;
    requestId: string;
    permissionPersistence?: PermissionPersistenceBackend;
    ipcDir?: string;
    onPersistentGrantApplied?: (recovery: PausedJobCapabilityRecheckResult) => Promise<void> | void;
}
interface PermissionInteractionGrantDependencies {
    permissionPersistence: PermissionPersistenceBackend | null;
    recordRunScopedTransientGrant(input: {
        appId?: string | null;
        runId: string;
        runLeaseToken?: string | null;
        runLeaseFencingVersion?: number | null;
        grant: Record<string, unknown>;
    }): Promise<void>;
}
export declare function applyPendingInteractionGrantDecision(input: PermissionInteractionDecisionInput, dependencies: PermissionInteractionGrantDependencies): Promise<boolean>;
export {};
