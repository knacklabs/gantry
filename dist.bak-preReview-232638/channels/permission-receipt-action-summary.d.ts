import type { PermissionApprovalRequest } from '../domain/types.js';
export interface StructuredPermissionReceiptActionSummary {
    text: string;
    bulkEligible: boolean;
}
export declare function formatStructuredPermissionReceiptActionSummary(request: PermissionApprovalRequest | undefined): StructuredPermissionReceiptActionSummary;
