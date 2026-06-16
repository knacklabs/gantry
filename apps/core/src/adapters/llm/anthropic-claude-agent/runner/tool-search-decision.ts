import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import type {
  AgentRunnerInput,
  AgentRunnerRuntimeEventOutput,
} from './types.js';

export type ClaudeSdkToolSearchMode = 'auto:10' | 'false';

export interface ClaudeSdkToolSearchDecision {
  enableToolSearch: ClaudeSdkToolSearchMode;
  reason:
    | 'official_auto_threshold'
    | 'non_first_party_base_url_tool_reference_unproven'
    | 'invalid_base_url_tool_reference_unproven'
    | 'no_registered_tools';
  availableToolCount: number;
  allowedToolCount: number;
  disallowedToolCount: number;
  mcpServerCount: number;
  serializedToolConfigBytes: number;
  anthropicBaseUrlKind: 'unset' | 'first_party' | 'non_first_party' | 'invalid';
}

export function decideClaudeSdkToolSearch(input: {
  sdkEnv: Record<string, string | undefined>;
  availableTools: readonly string[];
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  mcpServers: Record<string, unknown>;
}): ClaudeSdkToolSearchDecision {
  const availableToolCount = input.availableTools.length;
  const allowedToolCount = input.allowedTools.length;
  const disallowedToolCount = input.disallowedTools.length;
  const mcpServerCount = Object.keys(input.mcpServers).length;
  const serializedToolConfigBytes = Buffer.byteLength(
    JSON.stringify({
      tools: input.availableTools,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      mcpServers: input.mcpServers,
    }),
    'utf8',
  );
  const anthropicBaseUrlKind = classifyAnthropicBaseUrl(
    input.sdkEnv.ANTHROPIC_BASE_URL,
  );

  if (availableToolCount === 0 && mcpServerCount === 0) {
    return {
      enableToolSearch: 'false',
      reason: 'no_registered_tools',
      availableToolCount,
      allowedToolCount,
      disallowedToolCount,
      mcpServerCount,
      serializedToolConfigBytes,
      anthropicBaseUrlKind,
    };
  }

  if (anthropicBaseUrlKind === 'non_first_party') {
    return {
      enableToolSearch: 'false',
      reason: 'non_first_party_base_url_tool_reference_unproven',
      availableToolCount,
      allowedToolCount,
      disallowedToolCount,
      mcpServerCount,
      serializedToolConfigBytes,
      anthropicBaseUrlKind,
    };
  }

  if (anthropicBaseUrlKind === 'invalid') {
    return {
      enableToolSearch: 'false',
      reason: 'invalid_base_url_tool_reference_unproven',
      availableToolCount,
      allowedToolCount,
      disallowedToolCount,
      mcpServerCount,
      serializedToolConfigBytes,
      anthropicBaseUrlKind,
    };
  }

  return {
    enableToolSearch: 'auto:10',
    reason: 'official_auto_threshold',
    availableToolCount,
    allowedToolCount,
    disallowedToolCount,
    mcpServerCount,
    serializedToolConfigBytes,
    anthropicBaseUrlKind,
  };
}

export function toolSearchStartupRuntimeEvent(input: {
  agentInput: AgentRunnerInput;
  decision: ClaudeSdkToolSearchDecision;
}): AgentRunnerRuntimeEventOutput {
  return {
    ...(input.agentInput.appId ? { appId: input.agentInput.appId } : {}),
    ...(input.agentInput.agentId ? { agentId: input.agentInput.agentId } : {}),
    ...(input.agentInput.runId ? { runId: input.agentInput.runId } : {}),
    ...(input.agentInput.jobId ? { jobId: input.agentInput.jobId } : {}),
    conversationId: input.agentInput.chatJid,
    ...(input.agentInput.threadId
      ? { threadId: input.agentInput.threadId }
      : {}),
    eventType: RUNTIME_EVENT_TYPES.RUN_STARTUP_DIAGNOSTIC,
    actor: 'runtime',
    responseMode: 'none',
    payload: {
      provider: 'anthropic_sdk',
      diagnostic: 'tool_search',
      enableToolSearch: input.decision.enableToolSearch,
      reason: input.decision.reason,
      availableToolCount: input.decision.availableToolCount,
      allowedToolCount: input.decision.allowedToolCount,
      disallowedToolCount: input.decision.disallowedToolCount,
      mcpServerCount: input.decision.mcpServerCount,
      serializedToolConfigBytes: input.decision.serializedToolConfigBytes,
      anthropicBaseUrlKind: input.decision.anthropicBaseUrlKind,
    },
  };
}

function classifyAnthropicBaseUrl(
  value: string | undefined,
): ClaudeSdkToolSearchDecision['anthropicBaseUrlKind'] {
  const raw = value?.trim();
  if (!raw) return 'unset';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalid';
  }
  return parsed.hostname.toLowerCase() === 'api.anthropic.com'
    ? 'first_party'
    : 'non_first_party';
}
