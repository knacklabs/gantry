import type { McpToolAuditResultClass } from '../../application/mcp/mcp-tool-audit.js';
import {
  classifyMcpToolAuditError,
  summarizeMcpToolArgumentPayload,
  summarizeMcpToolError,
} from '../../application/mcp/mcp-tool-audit.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import type { McpCompatibleToolError } from '../../runtime/core-tools/contracts.js';

export type ThirdPartyMcpToolActivity = {
  serverName: string;
  toolName: string;
  toolInput: unknown;
  outcome: 'attempt' | 'success' | 'failure';
  latencyMs: number;
  result?: unknown;
  error?: unknown;
  resultClass?: McpToolAuditResultClass;
  structuredError?: McpCompatibleToolError;
};

export function isSuccessfulMcpActivity(
  activity: ThirdPartyMcpToolActivity,
): boolean {
  if (
    activity.outcome !== 'success' ||
    activity.error ||
    activity.structuredError
  ) {
    return false;
  }
  if (isMcpErrorResult(activity.result)) return false;
  if (activity.resultClass !== undefined) {
    return activity.resultClass === 'success';
  }
  return activity.result !== undefined;
}

export function isMcpErrorResult(result: unknown): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    (result as { isError?: unknown }).isError === true
  );
}

export function createInlineMcpActivityRecorder(input: {
  repository: Pick<McpServerRepository, 'appendAuditEvent'>;
  appId: string;
  agentId?: string;
  runId?: string;
  mcpServers: InlineAgentLoopLaneInput['mcpServers'];
  publishRuntimeEvent?: (event: RuntimeEventPublishInput) => Promise<void>;
  onSuccess(toolName: string): void;
}): (activity: ThirdPartyMcpToolActivity) => Promise<void> {
  return async (activity) => {
    const capability = input.mcpServers.find(
      ({ name }) => name === activity.serverName,
    );
    const resultClass =
      activity.resultClass ??
      (activity.outcome === 'success' && isMcpErrorResult(activity.result)
        ? 'failure'
        : undefined) ??
      (activity.outcome === 'failure'
        ? classifyMcpToolAuditError(activity.error)
        : activity.outcome);
    const payload = {
      serverName: activity.serverName,
      toolName: activity.toolName,
      requestedToolRule: `mcp__${activity.serverName}__${activity.toolName}`,
      resultClass,
      latencyMs: activity.latencyMs,
      argumentSummary: summarizeMcpToolArgumentPayload(activity.toolInput),
      ...(activity.structuredError
        ? { error: activity.structuredError }
        : activity.error
          ? { error: summarizeMcpToolError(activity.error) }
          : {}),
    };
    await input.repository.appendAuditEvent({
      id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
      appId: input.appId as never,
      agentId: input.agentId as never,
      serverId: capability?.serverId as never,
      bindingId: capability?.bindingId as never,
      eventType: 'tool_activity',
      actorId: { kind: 'system', source: 'inline-agent' },
      metadata: payload,
      createdAt: new Date().toISOString() as never,
    });
    if (isSuccessfulMcpActivity(activity)) {
      input.onSuccess(`mcp__${activity.serverName}__${activity.toolName}`);
    }
    if (!input.publishRuntimeEvent) return;
    await input
      .publishRuntimeEvent({
        appId: input.appId as never,
        agentId: input.agentId as never,
        runId: input.runId as never,
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        actor: { kind: 'system', source: 'inline-agent' },
        responseMode: 'none',
        payload,
      })
      .catch(() => undefined);
  };
}
