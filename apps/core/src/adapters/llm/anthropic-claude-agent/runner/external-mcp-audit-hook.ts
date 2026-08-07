import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

import {
  hashMcpAuditValue,
  projectMcpEvidence,
  summarizeMcpToolArgumentPayload,
} from '../../../../application/mcp/mcp-tool-audit.js';
import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import type { AgentRunnerInput } from './types.js';
import { writeOutput } from './output.js';

type ExternalMcpTerminalHook = HookInput & {
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  error?: unknown;
  duration_ms?: number;
};

export function auditExternalMcpTerminal(input: {
  hookInput: HookInput;
  toolUseId?: string;
  serverNames: readonly string[];
  agentInput: AgentRunnerInput;
  write?: typeof writeOutput;
}): { updatedToolOutput?: unknown; auditedToolCallId?: string } {
  const hook = input.hookInput as ExternalMcpTerminalHook;
  if (
    hook.hook_event_name !== 'PostToolUse' &&
    hook.hook_event_name !== 'PostToolUseFailure'
  ) {
    return {};
  }
  const toolName = hook.tool_name ?? '';
  const serverName = input.serverNames
    .filter((name) => name !== 'gantry')
    .sort((left, right) => right.length - left.length)
    .find((name) => toolName.startsWith(`mcp__${name}__`));
  const toolCallId = input.toolUseId ?? hook.tool_use_id;
  if (!serverName || !toolCallId) return {};
  return auditExternalMcpResult({
    toolName,
    toolCallId,
    toolInput: hook.tool_input,
    toolResponse: hook.tool_response,
    failed: hook.hook_event_name === 'PostToolUseFailure',
    durationMs: hook.duration_ms,
    serverNames: input.serverNames,
    agentInput: input.agentInput,
    write: input.write,
    updateToolOutput: true,
  });
}

export function auditExternalMcpResult(input: {
  toolName: string;
  toolCallId: string;
  toolInput: unknown;
  toolResponse: unknown;
  failed: boolean;
  durationMs?: number;
  serverNames: readonly string[];
  agentInput: AgentRunnerInput;
  write?: typeof writeOutput;
  updateToolOutput?: boolean;
}): { updatedToolOutput?: unknown; auditedToolCallId?: string } {
  const serverName = input.serverNames
    .filter((name) => name !== 'gantry')
    .sort((left, right) => right.length - left.length)
    .find((name) => input.toolName.startsWith(`mcp__${name}__`));
  if (!serverName) return {};
  const resultClass = input.failed ? 'failure' : 'success';
  const payload = {
    toolCallId: input.toolCallId,
    serverName,
    toolName: input.toolName.slice(`mcp__${serverName}__`.length),
    requestedToolRule: input.toolName,
    resultClass,
    latencyMs: Math.max(0, input.durationMs ?? 0),
    argumentSummary: summarizeMcpToolArgumentPayload(input.toolInput),
    inputHash: hashMcpAuditValue(input.toolInput),
    ...(resultClass === 'success'
      ? {
          resultHash: hashMcpAuditValue(input.toolResponse),
          evidenceProjection: projectMcpEvidence(input.toolResponse),
        }
      : { error: { message: 'MCP tool call failed.' } }),
  };
  (input.write ?? writeOutput)({
    status: 'success',
    result: null,
    runtimeEventOnly: true,
    runtimeEvents: [
      {
        appId: input.agentInput.appId,
        agentId: input.agentInput.agentId,
        runId: input.agentInput.runId,
        jobId: input.agentInput.jobId,
        conversationId: input.agentInput.chatJid,
        threadId: input.agentInput.threadId,
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        actor: 'sdk-external-mcp-audit',
        responseMode: 'none',
        payload,
      },
    ],
  });
  return resultClass === 'success' && input.updateToolOutput
    ? {
        updatedToolOutput: mcpToolOutputWithProvenance(
          input.toolResponse,
          input.toolCallId,
        ),
        auditedToolCallId: input.toolCallId,
      }
    : { auditedToolCallId: input.toolCallId };
}

export function mcpToolOutputWithProvenance(
  toolResponse: unknown,
  toolCallId: string,
): unknown {
  const provenance = {
    type: 'text',
    text: JSON.stringify({ gantryProvenance: { toolCallId } }),
  };
  if (Array.isArray(toolResponse)) return [...toolResponse, provenance];
  if (toolResponse && typeof toolResponse === 'object') {
    const response = toolResponse as Record<string, unknown>;
    if (Array.isArray(response.content)) {
      return { ...response, content: [...response.content, provenance] };
    }
  }
  return toolResponse;
}
