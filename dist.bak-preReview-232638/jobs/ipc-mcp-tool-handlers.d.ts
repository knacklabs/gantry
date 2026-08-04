import type { McpToolProxy } from '../application/mcp/mcp-tool-proxy.js';
import { TaskHandler } from './ipc-types.js';
type CreateMcpProxyForSourceGroup = (input: {
    appId: import('../domain/app/app.js').AppId;
    agentId: import('../domain/agent/agent.js').AgentId;
    deps: Parameters<TaskHandler>[0]['deps'];
    ipcDir?: string;
    runHandle?: string;
    runId?: string;
}) => Promise<McpToolProxy>;
export declare function createMcpToolHandlers(createMcpProxyForSourceGroup: CreateMcpProxyForSourceGroup): {
    mcpListToolsHandler: TaskHandler;
    mcpSearchToolsHandler: TaskHandler;
    mcpDescribeToolHandler: TaskHandler;
    mcpCallToolHandler: TaskHandler;
    asyncMcpCallToolHandler: TaskHandler;
};
export {};
