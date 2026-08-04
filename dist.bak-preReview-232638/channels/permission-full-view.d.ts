import type { PermissionApprovalRequest, InteractionFile } from '../domain/types.js';
export interface PermissionPromptFullView {
    label: string;
    title: string;
    filename: string;
    content: string;
}
export declare function buildPermissionPromptFullView(request: PermissionApprovalRequest): PermissionPromptFullView | undefined;
export declare function formatInteractionDetailLine(label: string, value: string, mono: boolean | undefined, sanitizePermissionText: (input: string, head: number, tail: number) => string): string;
export declare function formatInteractionFileLines(files: InteractionFile[], sanitizePermissionText: (input: string, head: number, tail: number) => string): string[];
