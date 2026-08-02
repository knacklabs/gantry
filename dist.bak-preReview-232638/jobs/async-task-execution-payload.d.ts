import type { AsyncCommandLaunchControl, StartAsyncCommandTaskInput } from './async-command-task-service.js';
import type { StartDelegatedAgentTaskInput } from './async-delegated-agent-task.js';
export declare function withEncryptedAsyncTaskPayload(privateCorrelationJson: Record<string, unknown>, input: {
    appId: string;
    taskId: string;
    payload: unknown;
}): Record<string, unknown>;
export declare function asyncCommandPrivateCorrelation(input: {
    appId: string;
    taskId: string;
    command: string;
    launchControl: AsyncCommandLaunchControl;
    taskInput: Pick<StartAsyncCommandTaskInput, 'allowedNetworkHosts' | 'cwd' | 'egressProxyUrl' | 'parentTaskId' | 'providerAccountId' | 'protectedReadPaths' | 'protectedWritePaths' | 'resourceLimits'>;
}): Record<string, unknown>;
export declare function asyncMcpPrivateCorrelation(input: {
    appId: string;
    taskId: string;
    parentTaskId?: string | null;
    providerAccountId?: string | null;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
}): Record<string, unknown>;
export declare function asyncDelegatedPrivateCorrelation(input: {
    appId: string;
    taskId: string;
    taskInput: Pick<StartDelegatedAgentTaskInput, 'context' | 'expectedOutput' | 'objective' | 'providerAccountId' | 'targetAgentId' | 'workspaceFolder'>;
}): Record<string, unknown>;
export declare function readEncryptedAsyncTaskPayload<T>(task: {
    appId: string;
    id: string;
    privateCorrelationJson: Record<string, unknown>;
}): T | null;
export declare class AsyncTaskPayloadCryptoConfigurationError extends Error {
}
