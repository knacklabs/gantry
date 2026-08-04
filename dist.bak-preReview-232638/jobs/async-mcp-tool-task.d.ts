import type { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
type DurableAsyncMcpPayload = {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
};
export declare function createAsyncMcpTask(input: {
    repository: AsyncTaskRepository;
    appId: string;
    agentId: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
    jobId?: string;
    runId?: string;
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
}): Promise<{
    ok: true;
    task: AsyncTaskRecord;
} | {
    ok: false;
    message: string;
}>;
export declare function enqueueAsyncMcpTask(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
    proxy: McpToolProxy;
    appId: string;
    agentId: string;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
}): Promise<void>;
export declare function recoverQueuedAsyncMcpTasks(input: {
    repository: AsyncTaskRepository;
    appId: string;
    agentId?: string;
    createProxy: (task: AsyncTaskRecord, payload: DurableAsyncMcpPayload) => Promise<McpToolProxy> | McpToolProxy;
    limit?: number;
}): Promise<number>;
export declare function executeAsyncMcpTask(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
    proxy: McpToolProxy;
    appId: string;
    agentId: string;
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
}): Promise<void>;
export declare function cancelAsyncMcpTask(repository: AsyncTaskRepository, task: AsyncTaskRecord): Promise<{
    ok: boolean;
    message: string;
}>;
export {};
