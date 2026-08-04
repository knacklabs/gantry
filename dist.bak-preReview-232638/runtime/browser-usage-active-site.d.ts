import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';
import type { BrowserSessionStatus } from './browser-capability-types.js';
import type { BrowserUsageSettings } from './browser-usage-governor.js';
type BrowserUsageBackend = (input: {
    toolName: BrowserBackendAction;
    arguments: Record<string, unknown>;
    session: BrowserSessionStatus;
    fileAccessRoot: string;
    timeoutMs?: number;
}) => Promise<unknown>;
export declare function browserUsagePayloadUrl(action: BrowserBackendAction, payload: Record<string, unknown>): string | undefined;
export declare function resolveActiveBrowserUrlForUsage(input: {
    action: BrowserBackendAction;
    payload: Record<string, unknown>;
    browserIpcAuthorized?: boolean;
    profileName: string;
    settings: BrowserUsageSettings | undefined;
    timeoutMs?: number;
    deadlineAtMs?: number;
    sourceAgentFolder: string;
    callBrowserTool?: BrowserUsageBackend;
    fileAccessRoot: string;
}): Promise<string | undefined>;
export {};
