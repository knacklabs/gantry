import type { PermissionApprovalUpdate } from '../domain/types.js';
export interface CollectedPrimeToolAttempt {
    requestedToolName: string;
    toolName: string;
    toolInput?: unknown;
    suggestions?: unknown[];
}
export interface JobPrimingSuggestion {
    toolName: string;
    requestedToolName: string;
    suggestions: PermissionApprovalUpdate[];
}
export declare class JobPrimingService {
    formatPermissionSuggestions(attempts: readonly CollectedPrimeToolAttempt[]): JobPrimingSuggestion[];
}
