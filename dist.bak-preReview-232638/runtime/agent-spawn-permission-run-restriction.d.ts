import type { AgentInput } from './agent-spawn-types.js';
export declare function registerWorkerPermissionRunRestriction(input: {
    sourceAgentFolder: string;
    responseKeyId: string;
    hideAuthorityTools: boolean;
}): void;
export declare function setupPermissionRunRestriction(sourceAgentFolder: string, agentInput: Pick<AgentInput, 'threadId' | 'appId' | 'agentId'>, hideAuthorityTools: boolean): {
    ipcAuth: {
        authToken: string;
        responseVerifyKey: string;
        responseKeyId: string;
    };
    unregisterPermissionRunRestriction: () => void;
};
