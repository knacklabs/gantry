interface PermissionDecisionMessageMetadata {
    decidedBy?: string;
    risk_level?: string;
    risk_category?: string;
}
export declare function formatPermissionDeniedMessage(decision: PermissionDecisionMessageMetadata, reason: string): string;
export {};
