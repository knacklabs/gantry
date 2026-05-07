import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerSchedulerTools } from './tools/scheduler.js';
import { registerServiceTools } from './tools/service.js';
import { parseEnabledMyClawMcpToolNames } from '../myclaw-mcp-tool-surface.js';

type McpToolRegistrar = {
  tool: (name: string, ...args: unknown[]) => unknown;
};

function filteredToolRegistrar(
  server: McpServer,
  enabledTools: ReadonlySet<string>,
): McpServer {
  const target = server as unknown as McpToolRegistrar;
  const registrar: McpToolRegistrar = {
    tool: (name, ...args) => {
      if (!enabledTools.has(name)) return undefined;
      return target.tool(name, ...args);
    },
  };
  return registrar as unknown as McpServer;
}

export function createMyClawMcpServer(): McpServer {
  const server = new McpServer({
    name: 'myclaw',
    version: '1.0.0',
  });
  const enabledTools = parseEnabledMyClawMcpToolNames(
    process.env.MYCLAW_MCP_TOOL_NAMES_JSON,
  );
  const filteredServer = filteredToolRegistrar(server, enabledTools);

  registerMessagingTools(filteredServer);
  registerSchedulerTools(filteredServer);
  registerMemoryTools(filteredServer);
  registerBrowserTools(filteredServer);
  registerServiceTools(filteredServer);

  return server;
}
