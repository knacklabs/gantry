import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBrowserTools } from './tools/browser.js';
import { registerFileTools } from './tools/file.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerProfileTools } from './tools/profile.js';
import { registerSchedulerTools } from './tools/scheduler.js';
import { registerServiceTools } from './tools/service.js';
import { registerTaskLifecycleTools } from './tools/task-lifecycle.js';
import {
  ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES,
  parseEnabledGantryMcpToolNames,
} from '../gantry-mcp-tool-surface.js';
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
    process.env.GANTRY_NO_PERMISSION_TOOLS,
    process.env.GANTRY_AGENT_ACCESS_PRESET === 'locked',
    process.env.GANTRY_ASYNC_TASK_TOOLS_ENABLED,
  );
  const registeredHandlers = new Set<string>();
  const filteredServer = filteredToolRegistrar(
    server,
    enabledTools,
    registeredHandlers,
  );

  registerMessagingTools(filteredServer);
  registerSchedulerTools(filteredServer);
  registerTaskLifecycleTools(filteredServer);
  registerMemoryTools(filteredServer);
  registerBrowserTools(filteredServer);
  registerFileTools(filteredServer);
  registerProfileTools(filteredServer);
  registerServiceTools(filteredServer);

  assertRegisteredMcpToolHandlers({ enabledTools, registeredHandlers });

  return server;
}

export function effectiveEnabledMcpToolNames(
  rawToolNames: string | undefined,
  rawAdminToolNames: string | undefined,
  rawNoPermissionTools = process.env.GANTRY_NO_PERMISSION_TOOLS,
  lockedPreset = process.env.GANTRY_AGENT_ACCESS_PRESET === 'locked',
  rawAsyncTaskToolsEnabled = process.env.GANTRY_ASYNC_TASK_TOOLS_ENABLED,
): Set<string> {
  const enabledTools = new Set(
    parseEnabledGantryMcpToolNames(rawToolNames, { lockedPreset }),
  );
  const selectedAdminTools = parseSelectedAdminMcpToolNames(rawAdminToolNames);
  // Locked agents never mount admin tools, even when capabilities selected them.
  if (!lockedPreset) {
    for (const toolName of selectedAdminTools) {
      if (isAdminMcpToolName(toolName)) enabledTools.add(toolName);
    }
  }

  if (lockedPreset || rawNoPermissionTools === '1') {
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
      enabledTools.delete(toolName);
    }
    for (const toolName of ADMIN_MCP_TOOL_NAMES) {
      enabledTools.delete(toolName);
    }
    // Locked never restores admin tools; non-locked no-permission mode keeps the
    // previously selected admin tools so admin agents stay functional.
    if (!lockedPreset) {
      for (const toolName of selectedAdminTools) enabledTools.add(toolName);
    }
  }
  if (rawAsyncTaskToolsEnabled !== '1') {
    for (const toolName of [
      ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
      ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
    ]) {
      enabledTools.delete(toolName);
    }
  }
  return enabledTools;
}

function parseSelectedAdminMcpToolNames(raw: string | undefined): Set<string> {
  const selected = new Set<string>();
  if (!raw?.trim()) return selected;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return selected;
    for (const item of parsed) {
      const toolName = typeof item === 'string' ? item.trim() : '';
      if (isAdminMcpToolName(toolName)) selected.add(toolName);
    }
  } catch {
    return selected;
  }
  return selected;
}
