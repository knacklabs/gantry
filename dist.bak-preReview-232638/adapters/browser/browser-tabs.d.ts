import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
export declare function clearBrowserTabIndexMappings(profileName?: string): void;
export declare function translateBrowserTabsInput(toolName: BrowserBackendAction, args: Record<string, unknown>, sessionKey: string): Record<string, unknown>;
export declare function projectBrowserTabsResult(result: unknown, sessionKey?: string, toolName?: BrowserBackendAction, args?: Record<string, unknown>): unknown;
