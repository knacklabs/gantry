import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
export declare function normalizeBrowserDirectPayload(toolName: BrowserBackendAction, payload: Record<string, unknown>, options: {
    fileAccessRoot: string;
}): Record<string, unknown>;
export declare function formFields(value: unknown): Array<{
    target: string;
    type: string;
    value: string;
}>;
