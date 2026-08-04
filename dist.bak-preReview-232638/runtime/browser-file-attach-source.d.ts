import type { FileArtifactStore } from '../domain/ports/file-artifact-store.js';
import type { BrowserBackendAction } from '../shared/browser-backend-actions.js';
export interface BrowserFileAttachRequest {
    action: BrowserBackendAction;
    payload: Record<string, unknown>;
    appId?: string;
    agentId?: string;
}
export declare function resolveBrowserFileAttachPayload(input: {
    request: BrowserFileAttachRequest;
    sourceAgentFolder: string;
    getFileArtifactStore?: () => FileArtifactStore | undefined;
}): Promise<Record<string, unknown>>;
