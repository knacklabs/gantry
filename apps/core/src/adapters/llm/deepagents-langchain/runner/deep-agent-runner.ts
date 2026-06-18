import { createDeepAgent, StateBackend } from 'deepagents';
import type { FilesystemPermission } from 'deepagents';
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';

import { buildRunnerModel } from './model-factory.js';
import {
  applyCachePromptControl,
  parseCachePromptControlMode,
} from './cache-control.js';
import {
  normalizeDeepAgentStream,
  type LangGraphStreamEvent,
} from './stream-normalizer.js';
import type { NormalizedCacheProvider } from '../../../../shared/model-catalog.js';
import {
  composeDeepAgentSystemPrompt,
  readMemoryContextBlock,
} from './system-prompt.js';
import { createBuiltinToolExclusionMiddleware } from './builtin-tool-exclusion.js';
import { connectGantryAndThirdPartyMcpTools } from './mcp-tools.js';
import { buildPermissionIpcRuntimeEnv } from './runtime-env.js';
import type { DeepAgentRunnerInput } from './types.js';
import type { PersistedTurnMessage } from './session-store.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import { nowMs } from '../../../../shared/time/datetime.js';

// Raw DeepAgents authority is fully disabled in v1: the default in-memory
// StateBackend has no `execute` tool, and these deny-all rules block every
// built-in filesystem tool (ls/read_file/write_file/edit_file/glob/grep). Never
// pass LocalShellBackend/FilesystemBackend or any sandbox backend. All reachable
// tools come ONLY from Gantry-owned MCP authority (facade tools plus selected
// first-party projections such as Browser). The `task` subagent tool and
// `write_todos` are excluded from the model-visible surface (see
// builtin-tool-exclusion.ts). External third-party MCP config is rejected in
// this lane until Gantry owns a DNS-pinned dispatcher/proxy path.
const DENY_ALL_FILESYSTEM: FilesystemPermission[] = [
  { operations: ['read', 'write'], paths: ['/**'], mode: 'deny' },
];

// Minimal structural view of the compiled DeepAgents graph the runner drives.
interface DeepAgentGraph {
  streamEvents(
    input: { messages: BaseMessage[] },
    options: { version: 'v2'; signal?: AbortSignal },
  ): AsyncIterable<LangGraphStreamEvent>;
}

interface ModelProfileLike {
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface DeepAgentTurnResult {
  text: string;
  messages: PersistedTurnMessage[];
  // Terminal-frame payload for the single per-turn terminal marker the caller
  // (runner index) emits; it folds in the continuation/stop decision (R2/R3).
  terminalResult: string | null;
  terminalUsage: RunnerOutputFrame['usage'];
  terminalContextUsage: RunnerOutputFrame['contextUsage'];
}

export async function runDeepAgentTurn(input: {
  agentInput: DeepAgentRunnerInput;
  provider: string;
  modelId: string;
  // Curated context window (host-projected) for empty-profile models; threaded
  // to the model profile's `maxInputTokens` for window-aware compaction +
  // context-usage. Undefined for ids with a real library profile.
  maxInputTokens?: number;
  priorMessages: PersistedTurnMessage[];
  newSessionId: string;
  emit: (frame: RunnerOutputFrame) => void;
  log?: (message: string) => void;
  // Marks tool activity (by name) on each tool-call start; the scheduled-job
  // heartbeat wires this so a long-running tool keeps the lease alive.
  onToolStart?: (toolName: string) => void;
  // STOP delivered via the close sentinel aborts the in-flight LangGraph stream
  // through this signal so the run terminates promptly (live-turn parity).
  signal?: AbortSignal;
}): Promise<DeepAgentTurnResult> {
  const startedAt = nowMs();
  const logElapsed = (message: string) => {
    input.log?.(`${message} after ${Math.max(0, nowMs() - startedAt)}ms`);
  };
  const gateway = resolveGatewayCredentialEnv(
    input.agentInput.modelCredentialEnv ?? {},
  );
  // Stable durable session id for OpenRouter sticky cache routing. The runner's
  // newSessionId is the durable session id for the conversation (resumed
  // agentInput.sessionId, else freshly minted by the store), so cache hits
  // persist across turns of the same conversation.
  const stickySessionId = input.agentInput.sessionId ?? input.newSessionId;
  const resolved = await buildRunnerModel({
    provider: input.provider,
    modelId: input.modelId,
    gatewayBaseUrl: gateway.baseUrl,
    gatewayToken: gateway.token,
    sessionId: stickySessionId,
    ...(input.maxInputTokens !== undefined
      ? { maxInputTokens: input.maxInputTokens }
      : {}),
  });
  logElapsed('Model built');
  const systemPrompt = composeDeepAgentSystemPrompt(input.agentInput);
  logElapsed('System prompt composed');

  const configuredAllowedTools = input.agentInput.allowedTools ?? [];
  const memoryBlock = readMemoryContextBlock(input.agentInput);
  const permissionEnv = buildPermissionIpcRuntimeEnv();
  logElapsed('Permission env prepared');
  const connected = await connectGantryAndThirdPartyMcpTools({
    configuredAllowedTools,
    hideAuthorityTools: input.agentInput.hideAuthorityTools === true,
    // The gated shell tool (when projected) runs commands as a child of this
    // already-sandboxed runner; thread the run-cancellation signal so an
    // in-flight command is killed on STOP/close.
    ...(input.signal ? { shellSignal: input.signal } : {}),
    gate: {
      workspaceFolder: input.agentInput.workspaceFolder,
      memoryBlock,
      gateContext: {
        isScheduledJob: input.agentInput.isScheduledJob,
        jobId: input.agentInput.jobId,
        threadId: input.agentInput.threadId,
        conversationId: input.agentInput.chatJid,
        yoloMode: input.agentInput.yoloMode,
      },
      permissionEnv,
      lockedAccessPreset: process.env.GANTRY_AGENT_ACCESS_PRESET === 'locked',
    },
  });
  logElapsed(`MCP tools connected (tools=${connected.tools.length})`);

  try {
    const agent = createDeepAgent({
      model: resolved.model,
      backend: new StateBackend(),
      permissions: DENY_ALL_FILESYSTEM,
      tools: connected.tools as StructuredToolInterface[] as never,
      middleware: [createBuiltinToolExclusionMiddleware()] as never,
      ...(systemPrompt ? { systemPrompt } : {}),
    }) as unknown as DeepAgentGraph;
    logElapsed('DeepAgent graph created');

    // Gated cache_control breakpoints: on 'explicit' the leading stable prompt
    // prefix (memory-block + first message) gets `cache_control:{ephemeral}`;
    // on 'automatic'/'none' (OpenAI/Kimi) nothing is injected.
    const cacheMode = parseCachePromptControlMode(
      process.env.GANTRY_DEEPAGENTS_CACHE_PROMPT_CONTROL,
    );
    const turnMessages = applyCachePromptControl(
      buildTurnMessages(input.agentInput, input.priorMessages),
      cacheMode,
    );
    logElapsed(
      `Turn messages built (messages=${turnMessages.length}, cacheMode=${cacheMode})`,
    );
    const profile = readModelProfile(resolved.model);

    const events = agent.streamEvents(
      { messages: turnMessages },
      { version: 'v2', ...(input.signal ? { signal: input.signal } : {}) },
    );
    logElapsed('LangGraph stream iterator created');
    const normalized = await normalizeDeepAgentStream({
      events,
      newSessionId: input.newSessionId,
      modelId: resolved.modelId,
      modelProfile: { maxInputTokens: profile.maxInputTokens },
      cacheProvider: cacheProviderForEndpoint(resolved.endpointFamily),
      emit: input.emit,
      onFirstEvent: (eventName) =>
        logElapsed(`First LangGraph event (${eventName})`),
      onFirstVisibleText: () => logElapsed('First visible text delta'),
      ...(input.onToolStart ? { onToolStart: input.onToolStart } : {}),
    });
    logElapsed('Stream normalized');
    const text = normalized.text;

    const userText = composeUserTurnText(input.agentInput);
    const messages: PersistedTurnMessage[] = [
      ...input.priorMessages,
      { role: 'human', text: userText },
      { role: 'ai', text },
    ];
    return {
      text,
      messages,
      terminalResult: normalized.terminalResult,
      terminalUsage: normalized.terminalUsage,
      terminalContextUsage: normalized.terminalContextUsage,
    };
  } finally {
    await connected.close().catch(() => {});
  }
}

// Exported for the memory-context placement test: the durable-memory block
// (which already carries the host's `<gantry_memory_context
// trust="untrusted_data_only">` framing) is injected exactly once as a leading
// HumanMessage — model-visible prompt context, never system authority.
export function buildTurnMessages(
  agentInput: DeepAgentRunnerInput,
  priorMessages: PersistedTurnMessage[],
): BaseMessage[] {
  const messages: BaseMessage[] = priorMessages.map((message) =>
    message.role === 'human'
      ? new HumanMessage(message.text)
      : new AIMessage(message.text),
  );
  const memoryBlock =
    typeof agentInput.memoryContextBlock === 'string'
      ? agentInput.memoryContextBlock.trim()
      : '';
  // Durable memory context is leading untrusted data, not system authority.
  if (memoryBlock) messages.push(new HumanMessage(memoryBlock));
  messages.push(new HumanMessage(agentInput.prompt));
  return messages;
}

function composeUserTurnText(agentInput: DeepAgentRunnerInput): string {
  return agentInput.prompt;
}

// The DeepAgents lane has a single gateway base-url + run-scoped token per run,
// projected under the OpenAI-family env names by the model gateway (both the
// OpenAI and OpenRouter providers project these keys). The provider string,
// projected separately as GANTRY_DEEPAGENTS_MODEL_PROVIDER, selects which
// LangChain class consumes them.
function resolveGatewayCredentialEnv(env: Record<string, string>): {
  baseUrl: string;
  token: string;
} {
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  const token = env.OPENAI_API_KEY?.trim();
  if (!baseUrl || !token) {
    throw new Error(
      'DeepAgents runner is missing gateway model credentials. Expected ' +
        'loopback OPENAI_BASE_URL/OPENAI_API_KEY from the model gateway.',
    );
  }
  return { baseUrl, token };
}

// Maps the resolved endpoint family to the prompt-cache provider the normalizer
// records, kept consistent with the host catalog's resolveModelCacheProvider:
// OpenAI gpt -> 'openai' (automatic prefix cache); OpenRouter Kimi/Moonshot ->
// 'openrouter-provider' (automatic provider-prefix cache). The runner derives
// this from the endpoint family so the normalizer needs no catalog import.
function cacheProviderForEndpoint(
  endpointFamily: 'openai' | 'openrouter',
): NormalizedCacheProvider {
  return endpointFamily === 'openrouter' ? 'openrouter-provider' : 'openai';
}

function readModelProfile(model: unknown): ModelProfileLike {
  try {
    const profile = (model as { profile?: ModelProfileLike }).profile;
    return profile && typeof profile === 'object' ? profile : {};
  } catch {
    return {};
  }
}
