import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { McpServerRepository } from '../../domain/ports/repositories.js';
import { redactSensitiveText } from '../../shared/sensitive-material.js';
import { nowIso } from '../../shared/time/datetime.js';
import { ApplicationError } from '../common/application-error.js';

export type McpToolAuditResultClass =
  'attempt' | 'invalid_request' | 'denied' | 'success' | 'timeout' | 'failure';

export function summarizeMcpToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(args).sort();
  return {
    kind: 'object',
    keyCount: keys.length,
    keys: keys.slice(0, 20),
    truncated: keys.length > 20,
    approxBytes: approximateJsonBytes(args),
  };
}

export function summarizeMcpToolArgumentPayload(
  value: unknown,
): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return summarizeMcpToolArguments(value as Record<string, unknown>);
  }
  return {
    kind:
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    keyCount: 0,
    keys: [],
    truncated: false,
    approxBytes: approximateJsonBytes(value),
  };
}

export async function publishInvalidMcpToolRequestAudit(input: {
  mcpServers: McpServerRepository;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  appId: AppId;
  agentId: AgentId;
  runId?: string;
  runHandle?: string;
  serverName?: string;
  toolName?: string;
  argumentPayload?: unknown;
  reason: string;
  missingFields?: string[];
}): Promise<void> {
  const reason = truncateAuditText(redactMcpAuditText(input.reason), 300);
  const payload = {
    ...(input.serverName ? { serverName: input.serverName } : {}),
    ...(input.toolName ? { toolName: input.toolName } : {}),
    ...(input.serverName && input.toolName
      ? { requestedToolRule: `mcp__${input.serverName}__${input.toolName}` }
      : {}),
    resultClass: 'invalid_request' satisfies McpToolAuditResultClass,
    latencyMs: 0,
    argumentSummary: summarizeMcpToolArgumentPayload(input.argumentPayload),
    reason,
    ...(input.missingFields && input.missingFields.length > 0
      ? { missingFields: input.missingFields }
      : {}),
    ...(input.runHandle ? { runHandle: input.runHandle } : {}),
  };
  await input.mcpServers.appendAuditEvent({
    id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
    appId: input.appId,
    agentId: input.agentId,
    eventType: 'tool_activity',
    actorId: 'mcp-tool-handler',
    reason,
    metadata: payload,
    createdAt: nowIso() as never,
  });
  if (!input.publishRuntimeEvent) return;
  try {
    await input.publishRuntimeEvent({
      appId: input.appId,
      agentId: input.agentId,
      ...(input.runId ? { runId: input.runId as AgentRunId } : {}),
      eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
      actor: 'mcp-tool-handler',
      responseMode: 'none',
      payload,
    });
  } catch {
    // Durable MCP audit is the source of truth; runtime events are observable
    // progress only and must not rewrite a malformed request outcome.
  }
}

export function classifyMcpToolAuditError(
  err: unknown,
): McpToolAuditResultClass {
  if (err instanceof ApplicationError && err.code === 'FORBIDDEN') {
    return 'denied';
  }
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  const name = err instanceof Error ? err.name.toLowerCase() : '';
  return name.includes('timeout') ||
    name.includes('abort') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('aborted')
    ? 'timeout'
    : 'failure';
}

export function summarizeMcpToolError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: truncateAuditText(redactMcpAuditText(err.message), 300),
    };
  }
  return { message: truncateAuditText(redactMcpAuditText(String(err)), 300) };
}

function approximateJsonBytes(value: unknown): number | 'unavailable' {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 'unavailable';
  }
}

function truncateAuditText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function redactMcpAuditText(value: string): string {
  return redactSensitiveText(value).replace(
    /\b(token|secret|password|api[_-]?key|authorization)\s*=\s*[^\s,;]+/gi,
    '$1=[REDACTED_SECRET]',
  );
}
