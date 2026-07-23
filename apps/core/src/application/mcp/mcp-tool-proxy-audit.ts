import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { nowIso } from '../../shared/time/datetime.js';
import type { McpToolAuditResultClass } from './mcp-tool-audit.js';
import type { ReviewedMaterializedMcpCapability } from './mcp-tool-authorization.js';

export async function publishMcpToolActivity(input: {
  mcpServers: McpServerRepository;
  options: {
    publishRuntimeEvent?: (
      event: RuntimeEventPublishInput,
    ) => Promise<unknown> | unknown;
    runId?: string;
    runHandle?: string;
  };
  activity: {
    input: {
      appId: AppId;
      agentId: AgentId;
      conversationId?: string;
      threadId?: string;
      serverName: string;
      toolName: string;
    };
    resultClass: McpToolAuditResultClass;
    latencyMs: number;
    argumentSummary: Record<string, unknown>;
    selectedToolRule?: string;
    selectedCapability?: Pick<
      ReviewedMaterializedMcpCapability,
      'name' | 'serverId' | 'bindingId' | 'sourceRevision'
    >;
    reason?: string;
    error?: Record<string, unknown>;
    outputSchemaPresent?: boolean;
    structuredResultValidated?: boolean;
    toolResultError?: boolean;
  };
}): Promise<void> {
  const activity = input.activity;
  const payload = {
    serverName: activity.input.serverName,
    toolName: activity.input.toolName,
    requestedToolRule: `mcp__${activity.input.serverName}__${activity.input.toolName}`,
    ...(activity.selectedToolRule
      ? { selectedToolRule: activity.selectedToolRule }
      : {}),
    ...(activity.selectedCapability
      ? {
          selectedCapability: {
            sourceId: `mcp:${activity.selectedCapability.name}`,
            serverId: activity.selectedCapability.serverId,
            bindingId: activity.selectedCapability.bindingId,
            ...(activity.selectedCapability.sourceRevision
              ? { sourceRevision: activity.selectedCapability.sourceRevision }
              : {}),
          },
        }
      : {}),
    resultClass: activity.resultClass,
    latencyMs: activity.latencyMs,
    argumentSummary: activity.argumentSummary,
    ...(activity.reason ? { reason: activity.reason } : {}),
    ...(activity.error ? { error: activity.error } : {}),
    ...(typeof activity.outputSchemaPresent === 'boolean'
      ? { outputSchemaPresent: activity.outputSchemaPresent }
      : {}),
    ...(typeof activity.structuredResultValidated === 'boolean'
      ? { structuredResultValidated: activity.structuredResultValidated }
      : {}),
    ...(typeof activity.toolResultError === 'boolean'
      ? { toolResultError: activity.toolResultError }
      : {}),
    ...(input.options.runHandle ? { runHandle: input.options.runHandle } : {}),
  };
  await input.mcpServers.appendAuditEvent({
    id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
    appId: activity.input.appId,
    agentId: activity.input.agentId,
    eventType: 'tool_activity',
    actorId: 'mcp-tool-proxy',
    ...(activity.reason ? { reason: activity.reason } : {}),
    metadata: payload,
    createdAt: nowIso() as never,
  });
  if (!input.options.publishRuntimeEvent) return;
  try {
    await input.options.publishRuntimeEvent({
      appId: activity.input.appId,
      agentId: activity.input.agentId,
      ...(input.options.runId
        ? { runId: input.options.runId as AgentRunId }
        : {}),
      eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
      actor: 'mcp-tool-proxy',
      responseMode: 'none',
      payload,
    });
  } catch {
    // The MCP audit table is the durable authority for tool-call evidence.
    // Runtime events are an observable projection and must not make a
    // completed external side effect look retryable to the model.
  }
}
