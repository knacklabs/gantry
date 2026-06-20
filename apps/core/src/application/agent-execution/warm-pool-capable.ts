import type { ChildProcess } from 'child_process';

import type {
  AgentExecutionAdapter,
  AgentExecutionProviderId,
} from './agent-execution-adapter.js';
import type { ThinkingOverride } from '../../domain/types.js';
import type { AgentPersona } from '../../shared/agent-persona.js';

export type WarmPoolKey = string;
export type WarmPoolCacheShapeKey = string;

export interface WarmPoolToolSurface {
  gantryMcp?: readonly string[];
  native?: readonly string[];
}

export interface WarmPoolKeyInput {
  providerId: AgentExecutionProviderId;
  credentialProfileRef?: string;
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
  runnerCommand?: string;
  runnerArgs?: readonly string[];
  runnerEnv?: NodeJS.ProcessEnv;
  runnerInput?: Record<string, unknown>;
  runnerProcessName?: string;
  cleanup?: () => Promise<void> | void;
  /**
   * Produce a fresh one-worker recipe for replacements. Use this when the
   * recipe owns per-worker resources such as credentials, response keys, or
   * egress gateways that are revoked by cleanup().
   */
  refresh?: () => Promise<SharedBootRecipe>;
}

export interface ConversationBindScope {
  groupFolder: string;
  appId: string;
  agentId: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryBlock?: string;
  firstMessage: string;
  guardrailPreface?: string;
  runHandle: string;
  ipcDir: string;
  ipcAuthToken: string;
  browserIpcAuthToken?: string;
  memoryIpcAuthToken: string;
  ipcResponseKeyId: string;
  ipcResponseVerifyKey: string;
  boundIdentityFile?: string;
  egressPrincipal?: string;
}

export interface WarmWorkerHandle {
  readonly id: string;
  readonly key: WarmPoolKey;
  readonly cacheShapeKey?: WarmPoolCacheShapeKey;
  readonly bornAt: number;
  readonly processName?: string;
  readonly groupFolder?: string;
  readonly ipcDir?: string;
  readonly boundIdentityFile?: string;
  readonly memoryIpcAuthToken?: string;
  cachePrewarm?: WarmWorkerCachePrewarmResult;
  bound: boolean;
}

export type WarmWorkerCachePrewarmResult =
  | {
      status: 'succeeded';
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export interface BoundRun {
  readonly handle: WarmWorkerHandle;
  readonly process: ChildProcess;
  readonly runHandle: string;
}

export interface WarmBindDelivery {
  deliver(
    handle: WarmWorkerHandle,
    scope: ConversationBindScope,
  ): Promise<boolean>;
  waitUntilReady?(
    handle: WarmWorkerHandle,
    input: { groupFolder: string; timeoutMs?: number },
  ): Promise<boolean>;
}

export interface WarmPoolCapable extends AgentExecutionAdapter {
  prewarm(shared: SharedBootRecipe): Promise<WarmWorkerHandle>;
  bind(
    handle: WarmWorkerHandle,
    scope: ConversationBindScope,
  ): Promise<BoundRun>;
  recycle(handle: WarmWorkerHandle): Promise<void>;
  healthCheck?(handle: WarmWorkerHandle): Promise<boolean>;
  prewarmCaches?(
    handle: WarmWorkerHandle,
  ): Promise<WarmWorkerCachePrewarmResult | void>;
  setWarmBindDelivery?(delivery: WarmBindDelivery): void;
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
    credentialProfileRef: input.credentialProfileRef ?? null,
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

export function cacheShapeKeyOf(
  input: WarmPoolKeyInput,
): WarmPoolCacheShapeKey {
  return JSON.stringify({
    providerFamily: input.providerId.split(':')[0] ?? input.providerId,
    executionProviderId: input.providerId,
    credentialProfileRef: input.credentialProfileRef ?? null,
    appId: input.appId,
    agentId: input.agentId,
    model: input.model ?? null,
    toolSurface: normalizeToolSurface(input.toolSurface),
    mcpSet: sortedList(input.mcpSet),
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
