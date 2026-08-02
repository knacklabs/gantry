import type { PermissionApprovalDecision, PermissionApprovalDecisionMode, PermissionApprovalRequest } from '../domain/types.js';
import { type PermissionPromptFullView } from './permission-full-view.js';
export { buildPermissionPromptFullView, type PermissionPromptFullView, } from './permission-full-view.js';
import { decisionForPermissionInteraction } from './permission-batch-coalescer.js';
export { firstPersistentRule, persistentPermissionUpdates, persistentRules, } from '../domain/permission-decision.js';
export { decisionForPermissionInteraction as decisionForMode };
export declare function normalizePermissionAction(action: string): PermissionApprovalDecisionMode | null;
export declare function permissionDecisionOptions(request: PermissionApprovalRequest, matchKind?: 'individual' | 'batch'): PermissionApprovalDecisionMode[];
export declare function permissionButtonLabel(mode: PermissionApprovalDecisionMode, _request: PermissionApprovalRequest): string;
export declare function formatPermissionPromptText(request: PermissionApprovalRequest, timeoutMs: number, options?: {
    budget?: number;
}): string;
export declare function formatPermissionReceiptText(_requestId: string, request: PermissionApprovalRequest | undefined, decision: PermissionApprovalDecision): string;
export declare const PERMISSION_GLYPH = "\uD83D\uDD10";
/** Provider-native prompt view; keep in sync with the plain-text formatter. */
export interface PermissionPromptParts {
    title: string;
    bodyLines: string[];
    contextLines: string[];
    replyInMinutes: number;
    fullView?: PermissionPromptFullView;
}
export declare function buildPermissionPromptParts(request: PermissionApprovalRequest, timeoutMs: number): PermissionPromptParts;
export declare function formatPermissionPromptPartsText(parts: PermissionPromptParts): string;
export declare function formatPermissionReceiptActionSummary(request: PermissionApprovalRequest | undefined): string;
