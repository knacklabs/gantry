import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

import type { MaterializedMcpCapability } from '../../application/mcp/mcp-server-service.js';
import type { LlmProfileResolution } from '../../application/model-resolution/llm-profile-resolution-service.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import type { AgentFailureMetadata } from '../../domain/ports/async-tasks.js';
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
import type { PermissionMode } from '../../shared/permission-mode.js';

export const DEFAULT_INLINE_AGENT_MAX_TURNS = 50;
const RESPONSE_SCHEMA_RETRY_LIMIT = 1;
const RESPONSE_SCHEMA_REPAIR_CANDIDATE_LIMIT = 4_096;
const responseSchemaCompiler = new Ajv({
  addUsedSchema: false,
  allErrors: true,
  strict: false,
});
export type InlineAgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

type InlineAgentOutputFrame = RunnerOutputFrame & {
  failure?: AgentFailureMetadata;
  structuredOutputValidationFailure?: true;
};

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
  permissionMode: PermissionMode;
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  parentTaskId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  responseSchema?: Record<string, unknown>;
  disableTools?: boolean;
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
  emitOutput(output: InlineAgentOutputFrame): Promise<void>;
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
) => Promise<InlineAgentOutputFrame>;

export type ProviderInlineAgentLoopLane = (
  input: AdapterInlineAgentLoopLaneInput & {
    coreTools: InlineCoreToolRegistry;
    egressDenylist: readonly string[];
  },
) => Promise<InlineAgentOutputFrame>;

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
    const coreTools = input.createCoreTools(laneInput);
    const egressDenylist = input.getEgressDenylist();
    if (!laneInput.input.responseSchema) {
      return lane({ ...laneInput, coreTools, egressDenylist });
    }

    let validate: ValidateFunction;
    try {
      validate = responseSchemaCompiler.compile(
        laneInput.input.responseSchema as AnySchema,
      );
    } catch (error) {
      const terminal = responseSchemaFailure(
        `response_schema could not be compiled: ${errorMessage(error)}`,
        null,
        laneInput.input.sessionId,
      );
      await laneInput.emitOutput(terminal);
      return terminal;
    }

    let attemptInput = laneInput;
    for (let attempt = 0; ; attempt += 1) {
      const output = await lane({
        ...attemptInput,
        coreTools,
        egressDenylist,
        emitOutput: async (frame) => {
          if (isObservableNonTerminalFrame(frame)) {
            await laneInput.emitOutput(frame);
          }
        },
      });
      if (
        output.status === 'error' &&
        output.structuredOutputValidationFailure !== true
      ) {
        await laneInput.emitOutput(output);
        return output;
      }

      const validation =
        output.status === 'error'
          ? {
              valid: false as const,
              error:
                output.error ??
                'the provider could not produce output matching response_schema',
            }
          : validateResponse(output.result, validate);
      if (validation.valid) {
        await laneInput.emitOutput(output);
        return output;
      }
      await emitInvalidAttemptUsage(laneInput.emitOutput, output);
      if (attempt >= RESPONSE_SCHEMA_RETRY_LIMIT) {
        const terminal = responseSchemaFailure(
          `Inline response failed response_schema validation after ${RESPONSE_SCHEMA_RETRY_LIMIT} retry: ${validation.error}`,
          output.result,
          output.newSessionId,
        );
        await laneInput.emitOutput(terminal);
        return terminal;
      }

      attemptInput = {
        ...laneInput,
        input: {
          ...laneInput.input,
          prompt: `${laneInput.input.prompt}\n\nYour previous response failed validation with: ${validation.error}\nFix it to satisfy response_schema.\n\nPrevious response:\n${boundedRepairCandidate(output.result)}\n\nReturn one corrected JSON response matching response_schema.`,
          disableTools: true,
        },
      };
    }
  };
}

function boundedRepairCandidate(candidate: string | null): string {
  if (candidate === null) return '(no candidate text)';
  if (candidate.length <= RESPONSE_SCHEMA_REPAIR_CANDIDATE_LIMIT) {
    return candidate;
  }
  return `${candidate.slice(0, RESPONSE_SCHEMA_REPAIR_CANDIDATE_LIMIT)}\n[truncated]`;
}

function validateResponse(
  candidate: string | null,
  validate: ValidateFunction,
): { valid: true } | { valid: false; error: string } {
  if (candidate === null) {
    return { valid: false, error: 'the model returned no candidate text' };
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    return {
      valid: false,
      error: `candidate is not valid JSON: ${errorMessage(error)}`,
    };
  }
  if (validate(value) === true) return { valid: true };
  const errors = validate.errors ?? [];
  return {
    valid: false,
    error:
      errors
        .slice(0, 3)
        .map(
          (error) =>
            `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
        )
        .join('; ') || '/ is invalid',
  };
}

function responseSchemaFailure(
  error: string,
  candidate: string | null,
  newSessionId?: string,
): InlineAgentOutputFrame {
  return {
    status: 'error',
    result: candidate,
    error,
    failure: {
      type: 'execution',
      attemptedAction: 'Validate inline response against response_schema',
      partialResult: candidate,
    },
    ...(newSessionId ? { newSessionId } : {}),
  };
}

async function emitInvalidAttemptUsage(
  emitOutput: AdapterInlineAgentLoopLaneInput['emitOutput'],
  frame: InlineAgentOutputFrame,
): Promise<void> {
  if (
    !frame.usage &&
    !frame.usageEventId &&
    !frame.contextUsage &&
    !frame.runtimeEvents?.length
  ) {
    return;
  }
  await emitOutput({
    status: 'success',
    result: null,
    runtimeEventOnly: true,
    ...(frame.newSessionId ? { newSessionId: frame.newSessionId } : {}),
    ...(frame.usage ? { usage: frame.usage } : {}),
    ...(frame.usageEventId ? { usageEventId: frame.usageEventId } : {}),
    ...(frame.contextUsage ? { contextUsage: frame.contextUsage } : {}),
    ...(frame.runtimeEvents ? { runtimeEvents: frame.runtimeEvents } : {}),
  });
}

function isObservableNonTerminalFrame(output: RunnerOutputFrame): boolean {
  return Boolean(
    output.sessionInit ||
    output.runtimeEventOnly ||
    output.compactBoundary ||
    output.interactionBoundary,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
