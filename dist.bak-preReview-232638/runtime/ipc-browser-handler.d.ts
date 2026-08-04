import { type BrowserBackendAction } from '../shared/browser-backend-actions.js';
import { type IpcDomainContext } from './ipc-domain-types.js';
interface BrowserRequest {
    requestId: string;
    action: BrowserBackendAction;
    payload: Record<string, unknown>;
    jobId?: string;
    runId?: string;
    appId?: string;
    agentId?: string;
    publicToolName?: string;
}
interface BrowserResponse {
    ok: boolean;
    data?: unknown;
    error?: string;
}
type BrowserContext = Pick<IpcDomainContext, 'sourceAgentFolder' | 'browserProfileName'> & {
    browserIpcAuthorized?: boolean;
    getFileArtifactStore?: IpcDomainContext['deps']['getFileArtifactStore'];
    callBrowserTool?: IpcDomainContext['deps']['callBrowserTool'];
    publishBrowserJobActivity?: IpcDomainContext['deps']['publishBrowserJobActivity'];
    closeBrowserToolBackends?: IpcDomainContext['deps']['closeBrowserToolBackends'];
    getBrowserUsageSettings?: IpcDomainContext['deps']['getBrowserUsageSettings'];
    timeoutMs?: number;
    deadlineAtMs?: number;
};
export declare function processBrowserIpcRequest(request: BrowserRequest, context: BrowserContext): Promise<BrowserResponse>;
export declare function writeBrowserIpcResponse(ipcBaseDir: string, sourceAgentFolder: string, response: {
    requestId: string;
    ok: boolean;
    data?: unknown;
    error?: string;
}, privateKeyPem?: string): void;
export {};
