import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import type {
  AgentRunnerInput,
  AgentRunnerRuntimeEventOutput,
} from './types.js';

export type ClaudeSdkToolSearchMode = 'auto:10' | 'false';
const ANTHROPIC_API_KEY_ENV = ['ANTHROPIC', 'API', 'KEY'].join('_');

export interface ClaudeSdkToolSearchDecision {
  enableToolSearch: ClaudeSdkToolSearchMode;
  reason:
    | 'official_auto_threshold'
    | 'gantry_gateway_tool_reference_pass_through'
    | 'non_first_party_base_url_tool_reference_unproven'
    | 'invalid_base_url_tool_reference_unproven'
    | 'no_registered_tools';
  availableToolCount: number;
  allowedToolCount: number;
  disallowedToolCount: number;
  mcpServerCount: number;
  serializedToolConfigBytes: number;
  anthropicBaseUrlKind:
    'unset' | 'first_party' | 'gantry_loopback' | 'non_first_party' | 'invalid';
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
    input.sdkEnv[ANTHROPIC_API_KEY_ENV],
  );
  const metrics = {
    availableToolCount,
    allowedToolCount,
    disallowedToolCount,
    mcpServerCount,
    serializedToolConfigBytes,
    anthropicBaseUrlKind,
  };

  if (availableToolCount === 0 && mcpServerCount === 0) {
    return {
      enableToolSearch: 'false',
      reason: 'no_registered_tools',
      ...metrics,
    };
  }

  if (anthropicBaseUrlKind === 'non_first_party') {
    return {
      enableToolSearch: 'false',
      reason: 'non_first_party_base_url_tool_reference_unproven',
      ...metrics,
    };
  }

  if (anthropicBaseUrlKind === 'invalid') {
    return {
      enableToolSearch: 'false',
      reason: 'invalid_base_url_tool_reference_unproven',
      ...metrics,
    };
  }

  return {
    enableToolSearch: 'auto:10',
    reason:
      anthropicBaseUrlKind === 'gantry_loopback'
        ? 'gantry_gateway_tool_reference_pass_through'
        : 'official_auto_threshold',
    ...metrics,
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
  apiKey: string | undefined,
): ClaudeSdkToolSearchDecision['anthropicBaseUrlKind'] {
  const raw = value?.trim();
  if (!raw) return 'unset';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalid';
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'api.anthropic.com') return 'first_party';
  if (
    (hostname === '127.0.0.1' || hostname === '::1') &&
    stripTrailingSlashes(parsed.pathname) === '/anthropic' &&
    apiKey?.startsWith('gtw_')
  ) {
    return 'gantry_loopback';
  }
  return 'non_first_party';
}

function stripTrailingSlashes(value: string): string {
  const stripped = value.replace(/\/+$/, '');
  return stripped || '/';
}
