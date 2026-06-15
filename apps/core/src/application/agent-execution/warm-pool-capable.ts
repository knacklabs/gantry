import type { ChildProcess } from 'child_process';

import type {
  AgentExecutionAdapter,
  AgentExecutionProviderId,
} from './agent-execution-adapter.js';
import type { ThinkingOverride } from '../../domain/types.js';
import type { AgentPersona } from '../../shared/agent-persona.js';

export type WarmPoolKey = string;

export interface WarmPoolToolSurface {
  gantryMcp?: readonly string[];
  native?: readonly string[];
}

export interface WarmPoolKeyInput {
  providerId: AgentExecutionProviderId;
  appId: string;
  agentId: string;
  persona?: AgentPersona;
  model?: string;
  toolSurface?: WarmPoolToolSurface;
  mcpSet?: readonly string[];
  thinking?: ThinkingOverride;
  systemPromptVersion: string;
}

export interface SharedBootRecipe extends WarmPoolKeyInput {
  key: WarmPoolKey;
  cwd: string;
  compiledSystemPrompt?: string;
}

export interface ConversationBindScope {
  appId: string;
  agentId: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  sessionId?: string;
  memoryBlock?: string;
  firstMessage: string;
  guardrailPreface?: string;
  runHandle: string;
  ipcInputDir: string;
  memoryIpcAuthToken: string;
  egressPrincipal?: string;
}

export interface WarmWorkerHandle {
  readonly id: string;
  readonly key: WarmPoolKey;
  readonly bornAt: number;
  readonly processName?: string;
  bound: boolean;
}

export interface BoundRun {
  readonly handle: WarmWorkerHandle;
  readonly process: ChildProcess;
  readonly runHandle: string;
}

export interface WarmPoolCapable extends AgentExecutionAdapter {
  prewarm(shared: SharedBootRecipe): Promise<WarmWorkerHandle>;
  bind(
    handle: WarmWorkerHandle,
    scope: ConversationBindScope,
  ): Promise<BoundRun>;
  recycle(handle: WarmWorkerHandle): Promise<void>;
  healthCheck?(handle: WarmWorkerHandle): Promise<boolean>;
  prewarmCaches?(handle: WarmWorkerHandle): Promise<void>;
}

function sortedList(values: readonly string[] | undefined): readonly string[] {
  return [...(values ?? [])].sort();
}

function normalizeToolSurface(
  toolSurface: WarmPoolToolSurface | undefined,
): Required<WarmPoolToolSurface> {
  return {
    gantryMcp: sortedList(toolSurface?.gantryMcp),
    native: sortedList(toolSurface?.native),
  };
}

function normalizeThinking(
  thinking: ThinkingOverride | undefined,
): Record<string, unknown> | null {
  if (!thinking) return null;
  return {
    mode: thinking.mode,
    effort: thinking.effort ?? null,
    budgetTokens: thinking.budgetTokens ?? null,
    display: thinking.display ?? null,
  };
}

export function poolKeyOf(input: WarmPoolKeyInput): WarmPoolKey {
  return JSON.stringify({
    providerId: input.providerId,
    appId: input.appId,
    agentId: input.agentId,
    persona: input.persona ?? null,
    model: input.model ?? null,
    toolSurface: normalizeToolSurface(input.toolSurface),
    mcpSet: sortedList(input.mcpSet),
    thinking: normalizeThinking(input.thinking),
    systemPromptVersion: input.systemPromptVersion,
  });
}

export function hasWarmPoolCapability(
  adapter: AgentExecutionAdapter,
): adapter is WarmPoolCapable {
  const candidate = adapter as AgentExecutionAdapter & {
    prewarm?: unknown;
    bind?: unknown;
    recycle?: unknown;
  };
  return (
    typeof candidate.prewarm === 'function' &&
    typeof candidate.bind === 'function' &&
    typeof candidate.recycle === 'function'
  );
}
