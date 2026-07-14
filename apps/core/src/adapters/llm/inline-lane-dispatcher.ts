import type { MaterializedMcpCapability } from '../../application/mcp/mcp-server-service.js';
import type { LlmProfileResolution } from '../../application/model-resolution/llm-profile-resolution-service.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import type { SkillArtifactStore } from '../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type {
  AgentControlThinking,
  ConversationRoute,
} from '../../domain/types.js';
import type { RunnerOutputFrame } from '../../runner/runner-frame.js';
import type { AgentPersona } from '../../shared/agent-persona.js';
import { DEFAULT_AGENT_ENGINE } from '../../shared/agent-engine.js';
import type { YoloModeSettings } from '../../shared/yolo-mode-policy.js';

export const DEFAULT_INLINE_AGENT_MAX_TURNS = 50;
export type InlineAgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function inlineAgentMaxTurnsError(
  limit: number,
  newSessionId?: string,
): RunnerOutputFrame {
  return {
    status: 'error',
    result: null,
    error: `Inline agent reached the max_turns cap (configured limit: ${limit}).`,
    ...(newSessionId ? { newSessionId } : {}),
  };
}

export interface AdapterInlineAgentInput {
  prompt: string;
  workspaceFolder: string;
  chatJid: string;
  compiledSystemPrompt: string;
  assistantName?: string;
  persona?: AgentPersona;
  appId?: string;
  agentId?: string;
  sessionId?: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryContextBlock?: string;
  attachedSkillSourceIds?: string[];
  toolPolicyRules?: string[];
  yoloMode?: YoloModeSettings;
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  parentTaskId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  responseSchema?: Record<string, unknown>;
}

export interface AdapterInlineControlPort {
  subscribe(subscriber: {
    onContinuation(input: { text: string }): void;
    onClose(): void;
  }): () => void;
}

export interface AdapterInlineAgentLoopLaneInput {
  group: ConversationRoute;
  input: AdapterInlineAgentInput;
  signal: AbortSignal;
  controlPort: AdapterInlineControlPort;
  resolvedModel: LlmProfileResolution;
  modelCredentialEnv: Readonly<Record<string, string>>;
  mcpServers: readonly MaterializedMcpCapability[];
  mcpHostnameLookup?: HostnameLookup;
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  skillContext?: { appId: string; agentId: string };
  runtimeDataDir: string;
  maxTurns?: number;
  effort?: InlineAgentEffort;
  configuredThinking?: AgentControlThinking;
  maxOutputTokens?: number;
  emitOutput(output: RunnerOutputFrame): Promise<void>;
}

export interface InlineCoreToolRegistry {
  tools: readonly {
    name: string;
    description: string;
    inputSchema: unknown;
  }[];
  execute(
    name: string,
    input: unknown,
    context?: { signal?: AbortSignal },
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }>;
  authorizeThirdPartyMcpTool(
    name: string,
    input: unknown,
    context?: { signal?: AbortSignal },
  ): Promise<{ allowed: boolean; reason?: string }>;
  recordThirdPartyMcpToolActivity(input: {
    serverName: string;
    toolName: string;
    toolInput: unknown;
    outcome: 'attempt' | 'success' | 'failure';
    latencyMs: number;
    error?: unknown;
  }): Promise<void>;
}

export interface InlineCoreToolSupport {
  schemaFactory: unknown;
  evaluateToolPreChecks: unknown;
  evaluateToolPolicy: unknown;
  formatMemorySearchResponse: unknown;
  formatMemoryWriteResponse: unknown;
}

export type AdapterInlineAgentLoopLane = (
  input: AdapterInlineAgentLoopLaneInput,
) => Promise<RunnerOutputFrame>;

export type ProviderInlineAgentLoopLane = (
  input: AdapterInlineAgentLoopLaneInput & {
    coreTools: InlineCoreToolRegistry;
    egressDenylist: readonly string[];
  },
) => Promise<RunnerOutputFrame>;

export function createInlineAgentLoopLaneDispatcher(input: {
  claudeLane: ProviderInlineAgentLoopLane;
  deepAgentsLane: ProviderInlineAgentLoopLane;
  createCoreTools: (
    laneInput: AdapterInlineAgentLoopLaneInput,
  ) => InlineCoreToolRegistry;
  getEgressDenylist: () => readonly string[];
}): AdapterInlineAgentLoopLane {
  return async (laneInput) => {
    if (!laneInput.resolvedModel.ok) {
      return {
        status: 'error',
        result: null,
        error: laneInput.resolvedModel.message,
      };
    }
    const lane =
      laneInput.resolvedModel.value.agentEngine === DEFAULT_AGENT_ENGINE
        ? input.claudeLane
        : input.deepAgentsLane;
    return lane({
      ...laneInput,
      coreTools: input.createCoreTools(laneInput),
      egressDenylist: input.getEgressDenylist(),
    });
  };
}
