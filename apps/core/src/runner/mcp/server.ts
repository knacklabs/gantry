import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerFileTools } from './tools/file.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerSchedulerTools } from './tools/scheduler.js';
import { registerServiceTools } from './tools/service.js';
import { parseEnabledGantryMcpToolNames } from '../gantry-mcp-tool-surface.js';
import {
  ADMIN_MCP_TOOL_NAMES,
  isAdminMcpToolName,
} from '../../shared/admin-mcp-tools.js';
import { formatOperatorError } from '../../shared/operator-error.js';

type McpToolRegistrar = {
  tool: (name: string, ...args: unknown[]) => unknown;
};

function filteredToolRegistrar(
  server: McpServer,
  enabledTools: ReadonlySet<string>,
  registeredHandlers: Set<string>,
): McpServer {
  const target = server as unknown as McpToolRegistrar;
  const registrar: McpToolRegistrar = {
    tool: (name, ...args) => {
      if (!enabledTools.has(name)) return undefined;
      const hasHandler = args.some((arg) => typeof arg === 'function');
      const registration = target.tool(name, ...args);
      if (hasHandler) registeredHandlers.add(name);
      return registration;
    },
  };
  return registrar as unknown as McpServer;
}

export function assertRegisteredMcpToolHandlers(input: {
  enabledTools: ReadonlySet<string>;
  registeredHandlers: ReadonlySet<string>;
}): void {
  const missingHandlers = [...input.enabledTools]
    .filter((toolName) => !input.registeredHandlers.has(toolName))
    .sort();

  if (missingHandlers.length === 0) return;

  throw new Error(
    formatOperatorError({
      summary: `Gantry could not start because ${missingHandlers[0]} is registered without a handler.`,
      cause: 'MCP tool registry mismatch',
      recover:
        'remove the tool registration or add its handler before starting Gantry.',
    }),
  );
}

export function createGantryMcpServer(): McpServer {
  const server = new McpServer({
    name: 'gantry',
    version: '1.0.0',
  });
  const enabledTools = effectiveEnabledMcpToolNames(
    process.env.GANTRY_MCP_TOOL_NAMES_JSON,
    process.env.GANTRY_ADMIN_MCP_TOOLS_JSON,
  );
  const registeredHandlers = new Set<string>();
  const filteredServer = filteredToolRegistrar(
    server,
    enabledTools,
    registeredHandlers,
  );

  registerMessagingTools(filteredServer);
  registerSchedulerTools(filteredServer);
  registerMemoryTools(filteredServer);
  registerBrowserTools(filteredServer);
  registerFileTools(filteredServer);
  registerServiceTools(filteredServer);

  assertRegisteredMcpToolHandlers({ enabledTools, registeredHandlers });

  return server;
}

function effectiveEnabledMcpToolNames(
  rawToolNames: string | undefined,
  _rawAdminToolNames: string | undefined,
): Set<string> {
  const enabledTools = new Set(
    [...parseEnabledGantryMcpToolNames(rawToolNames)].filter(
      (toolName) => !isAdminMcpToolName(toolName),
    ),
  );

  for (const toolName of ADMIN_MCP_TOOL_NAMES) enabledTools.add(toolName);

  return enabledTools;
}
