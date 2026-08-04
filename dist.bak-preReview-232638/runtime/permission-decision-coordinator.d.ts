import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../domain/types.js';
import { type PermissionDeterministicRailDecision, type PermissionDeterministicRailsInput } from '../domain/permission-deterministic-rails.js';
import type { ToolPolicyDecision } from '../shared/tool-execution-policy-service.js';
import type { PermissionDecisionMemoryRepository } from '../domain/ports/permission-decision-memory.js';
import type { PermissionClassifierRiskLevel } from './permission-classifier-prompt.js';
export type DeterministicPermissionRails = (input: PermissionDeterministicRailsInput) => PermissionDeterministicRailDecision | undefined;
export interface CoordinatePermissionDecisionInput {
    request: PermissionApprovalRequest;
    hardDenyReason?: string;
    accessPreset?: 'full' | 'locked';
    fixedImageRestricted?: boolean;
    reviewedRuleDecision?: ToolPolicyDecision | (() => Promise<ToolPolicyDecision | undefined>);
    deterministicRails?: DeterministicPermissionRails;
    deterministicRailsInput?: Omit<PermissionDeterministicRailsInput, 'request'>;
    /** Versioned effect hash (Task B); undefined ⇒ input uncacheable, cache skipped. */
    effectHash?: string;
    /** Classifier-verdict cache (Task C); read only on a rail fall-through. */
    decisionMemory?: PermissionDecisionMemoryRepository;
    tail: () => Promise<PermissionApprovalDecision>;
}
/**
 * The classifier judges intrinsic risk only. Authorization was already
 * consumed by the hard-deny, reviewed-rule/capability, deterministic-rail,
 * grant, and cache stages before this mapping is used.
 */
export declare function coordinatePermissionClassifierRisk<T>(input: {
    riskLevel: PermissionClassifierRiskLevel;
    allow: () => T | Promise<T>;
    tail: () => Promise<T>;
}): Promise<T>;
export declare function coordinatePermissionDecision(input: CoordinatePermissionDecisionInput): Promise<PermissionApprovalDecision>;
interface PermissionRunRestriction {
    hideAuthorityTools: boolean;
}
export declare function registerPermissionRunRestriction(input: {
    sourceAgentFolder: string;
    responseKeyId: string;
    hideAuthorityTools: boolean;
}): void;
export declare function permissionRunRestriction(input: {
    sourceAgentFolder: string;
    responseKeyId: string;
}): PermissionRunRestriction | undefined;
export declare function unregisterPermissionRunRestriction(input: {
    sourceAgentFolder: string;
    responseKeyId: string;
}): void;
export {};
