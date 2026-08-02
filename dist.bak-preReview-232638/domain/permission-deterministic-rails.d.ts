import type { PermissionApprovalDecision, PermissionApprovalRequest, PermissionRiskCategory, PermissionRiskLevel } from './types.js';
import { type McpReadBinding } from '../shared/auto-permission-read-only-gate.js';
export interface PermissionDeterministicRailsInput {
    request: PermissionApprovalRequest;
    approvedCapabilityIds?: readonly string[];
    workspaceRoot?: string;
    trustedRoots?: readonly string[];
    reviewedMcpReadBindings?: readonly McpReadBinding[];
}
export type PermissionDeterministicRailDecision = {
    railOutcome: 'ask';
    reason: string;
    railSignal: PermissionDeterministicRailSignal;
    hardFloor?: true;
} | (PermissionApprovalDecision & {
    railOutcome: 'allow' | 'deny';
});
export type PermissionDeterministicRailSignal = 'destructive' | 'egress' | 'privileged' | 'secret_path' | 'out_of_trusted_root';
export interface PermissionDeterministicRailRisk {
    level: PermissionRiskLevel;
    category: PermissionRiskCategory;
}
export declare function evaluatePermissionDeterministicRails(input: PermissionDeterministicRailsInput): PermissionDeterministicRailDecision | undefined;
export declare function permissionRiskForDeterministicRailDecision(decision: PermissionDeterministicRailDecision | undefined): PermissionDeterministicRailRisk | undefined;
