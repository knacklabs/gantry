import fs from 'node:fs';
import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
export declare function textResult(text: string): Record<string, unknown>;
export declare function browserFileReferenceResult(filename: string, stat?: fs.Stats, mimeType?: string): Record<string, unknown>;
export declare function writeOptionalTextOutput(text: string, args: Record<string, unknown>): unknown;
export declare function normalizeBrowserToolResult(toolName: BrowserBackendAction, args: Record<string, unknown>, result: unknown, options?: {
    artifactRoot?: string;
    tabSessionKey?: string;
}): unknown;
export declare function sanitizeBrowserTabsResult(result: unknown): unknown;
export declare function isInternalChromeTarget(url: string, title?: string): boolean;
