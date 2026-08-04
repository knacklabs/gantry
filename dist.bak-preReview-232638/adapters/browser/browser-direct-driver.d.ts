import type { BrowserBackendAction } from '../../shared/browser-backend-actions.js';
import { BROWSER_ACTION_TIMEOUT_MS } from './browser-direct-timeout.js';
export { BROWSER_ACTION_TIMEOUT_MS };
export { normalizeBrowserToolResult, sanitizeBrowserTabsResult, } from './browser-result-hygiene.js';
interface BrowserToolSession {
    running?: boolean;
    cdpReady?: boolean;
    port?: number;
    profileName?: string;
}
export declare function callBrowserTool(input: {
    toolName: BrowserBackendAction;
    arguments: Record<string, unknown>;
    session: BrowserToolSession;
    fileAccessRoot: string;
    timeoutMs?: number;
}): Promise<unknown>;
export declare function closeBrowserToolBackends(profileName?: string): Promise<void>;
declare function formatBackendError(toolName: string, err: unknown): string;
export { formatBackendError };
