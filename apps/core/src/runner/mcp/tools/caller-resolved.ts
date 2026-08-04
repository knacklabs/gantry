import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { submitTaskLifecycleRequest } from './task-lifecycle.js';

type CallerToolConfig = {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  interactionTimeoutMs: number;
};

export function callerResolvedToolConfig(
  raw = process.env.GANTRY_CALLER_RESOLVED_TOOLS_JSON,
): CallerToolConfig | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as CallerToolConfig;
    return Array.isArray(parsed.tools) &&
      parsed.tools.length > 0 &&
      Number.isInteger(parsed.interactionTimeoutMs) &&
      parsed.interactionTimeoutMs > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function registerCallerResolvedTools(server: McpServer): void {
  const config = callerResolvedToolConfig();
  if (!config) return;
  for (const definition of config.tools) {
    const schema = z.fromJSONSchema(definition.inputSchema);
    if (!(schema instanceof z.ZodObject)) {
      throw new Error(
        `Caller tool ${definition.name} inputSchema must describe an object.`,
      );
    }
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: schema.shape },
      async (args) =>
        submitTaskLifecycleRequest({
          type: 'caller_resolved_tool',
          payload: { toolName: definition.name, toolInput: args },
          responseTimeoutMs: config.interactionTimeoutMs + 20_000,
          timeoutMessage: 'Caller-resolved tool IPC response timed out.',
          fallbackError: 'Caller-resolved tool failed.',
        }),
    );
  }
}
