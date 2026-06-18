import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import { ApplicationError } from '../common/application-error.js';
import { isSourceInventoryToolAllowed } from './mcp-tool-authorization.js';
import type { ReviewedMaterializedMcpCapability } from './mcp-tool-authorization.js';
import { fetchMcpToolListPages } from './mcp-tool-list-fetch.js';
import type { McpToolListClient } from './mcp-tool-list-fetch.js';
import {
  approximateMcpMetadataBytes,
  cacheMcpToolDetail,
  type CachedMcpToolDetail,
  detailedMcpTool,
  readCachedMcpToolDetail,
} from './mcp-tool-inventory.js';

export async function fetchAndCacheMcpToolDetail(input: {
  request: {
    appId: AppId;
    agentId: AgentId;
    serverName: string;
    toolName: string;
  };
  capability: ReviewedMaterializedMcpCapability;
  client: McpToolListClient;
  timeoutMs: number;
}): Promise<CachedMcpToolDetail> {
  const tools = await fetchMcpToolListPages({
    client: input.client,
    timeoutMs: input.timeoutMs,
  });
  const tool = tools.tools.find(
    (candidate) => candidate.name === input.request.toolName,
  );
  if (!tool || !isSourceInventoryToolAllowed(input.capability, tool.name)) {
    throw new ApplicationError(
      'NOT_FOUND',
      `MCP tool is not available from source inventory: ${input.request.serverName}.${input.request.toolName}`,
    );
  }
  const detail = detailedMcpTool(input.capability, tool);
  return cacheMcpToolDetail(
    input.request,
    input.capability,
    input.request.toolName,
    {
      tool: detail,
      metadataBytes: approximateMcpMetadataBytes(detail),
    },
  );
}

export async function resolveMcpToolOutputSchema(input: {
  request: {
    appId: AppId;
    agentId: AgentId;
    serverName: string;
    toolName: string;
  };
  capability: ReviewedMaterializedMcpCapability;
  client: McpToolListClient;
  timeoutMs: number;
}): Promise<unknown | undefined> {
  const cached = readCachedMcpToolDetail(
    input.request,
    input.capability,
    input.request.toolName,
  );
  if (cached) return cached.tool.outputSchema;
  const detail = await fetchAndCacheMcpToolDetail(input);
  return detail.tool.outputSchema;
}
