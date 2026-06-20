import { ChildProcess } from 'child_process';

import { ConversationRoute, ThinkingOverride } from '../domain/types.js';
import type { AgentCredentialBroker } from '../domain/ports/agent-credential-broker.js';
import type { SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
} from '../domain/ports/repositories.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import type { RemoteMcpDnsValidationCache } from '../application/mcp/mcp-server-policy.js';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../shared/model-catalog.js';
import type { AgentPersona } from '../shared/agent-persona.js';
import type { PromptSurface } from '../shared/prompt-surface.js';
import type { YoloModeSettings } from '../shared/yolo-mode-policy.js';
import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type {
  SharedBootRecipe,
  WarmPoolKey,
  WarmWorkerHandle,
} from '../application/agent-execution/warm-pool-capable.js';
import type { OperationalTimelineSectionInput } from './reply-trace.js';
import type { WarmPoolInventorySnapshot } from './warm-pool-manager.js';

export interface AgentInput {
  prompt: string;
  appId?: string;
  agentId?: string;
  model?: string;
  groupFolder: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryReviewerIsControlApprover?: boolean;
  persona?: AgentPersona;
  promptSurface?: PromptSurface;
  browserProfileName?: string;
  allowedTools?: string[];
  /** Per-agent gantry MCP tool keep-list (settings `tool_surface.gantry_mcp`). */
  gantryMcpToolSurface?: string[];
  /** Per-agent native SDK tool keep-list (settings `tool_surface.native`). */
  nativeToolSurface?: string[];
  toolAccessRequirements?: string[];
  attachedSkillSourceIds?: string[];
  selectedSkillDisplays?: string[];
  attachedMcpSourceIds?: string[];
  semanticCapabilities?: SemanticCapabilityDefinition[];
  isScheduledJob?: boolean;
  jobId?: string;
  jobName?: string;
  runId?: string;
  jobModelUseKind?: 'oneTimeJob' | 'recurringJob';
  assistantName?: string;
  compiledSystemPrompt?: string;
  guardrailSystemPromptAppend?: string;
  thinking?: ThinkingOverride;
  memoryContextBlock?: string;
  yoloMode?: YoloModeSettings;
  runtimeAccess?: CapabilityRuntimeAccess[];
}

/**
 * One main-LLM assistant turn, surfaced from the child runner's stdout envelope
 * for the per-reply latency trace. Mirrors the runner-side `AgentRunnerLlmTurn`
 * (linked only by the JSON envelope) and the runtime `LlmTurnRecord` shape.
 */
export interface AgentOutputLlmTurn {
  ms: number;
  startedAt: number;
  detail: {
    model?: string;
    stopReason?: string;
    tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
  };
  input?: unknown;
  output?: string;
}

export interface AgentOutputToolCall {
  server: string;
  tool: string;
  ms: number;
  ok: boolean;
  startedAt: number;
  requestBytes: number;
  responseBytes: number;
  request?: unknown;
  response?: unknown;
}

export interface AgentOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  compactBoundary?: boolean;
  interactionBoundary?: 'user_interaction';
  continuedByFollowup?: boolean;
  usage?: NormalizedModelUsage;
  usageEventId?: string;
  contextUsage?: RuntimeContextUsageSnapshot;
  error?: string;
  runtimeEvents?: AgentOutputRuntimeEvent[];
  /** Per-turn LLM timing + usage for the latency trace (best-effort). */
  turns?: AgentOutputLlmTurn[];
  /** SDK/direct-MCP tool spans for the latency trace (best-effort). */
  toolCalls?: AgentOutputToolCall[];
  /** Run-level process-startup marks for the latency timeline (best-effort). */
  runnerStartup?: { queryDispatchedAt?: number; firstSdkMessageAt: number };
  /** First reply was served from an already-started generic warm worker. */
  warmBound?: boolean;
  /** Exact customer-free warm cache prewarm payload, gated by trace capture. */
  cachePrewarmTrace?: OperationalTimelineSectionInput;
  /** Warm continuation: when this reply's input was delivered to the model. */
  dispatchedAt?: number;
}

export interface AgentOutputRuntimeEvent {
  appId?: string;
  agentId?: string;
  runId?: string;
  jobId?: string;
  conversationId?: string;
  threadId?: string;
  eventType: string;
  actor?: string;
  responseMode?: 'sse' | 'webhook' | 'both' | 'none';
  payload: unknown;
}

export interface PooledWarmWorkerRun {
  handle: WarmWorkerHandle;
  release: () => Promise<void>;
}

export interface AgentProcessMetadata {
  pooledWarmWorker?: PooledWarmWorkerRun;
}

export interface WarmPoolRuntime {
  acquire(key: WarmPoolKey): WarmWorkerHandle | null;
  prewarm?(recipe: SharedBootRecipe, count: number): Promise<void>;
  healthCheck?(key?: WarmPoolKey): Promise<void>;
  evictIdle?(ttlMs: number): Promise<void>;
  inventory?(): WarmPoolInventorySnapshot;
  release(handle: WarmWorkerHandle): Promise<void>;
  reapOrphans?(): Promise<number>;
  shutdown?(): Promise<void>;
}

export interface RunAgentOptions {
  timeoutMs?: number;
  credentialBroker?: AgentCredentialBroker;
  skillRepository?: SkillCatalogRepository;
  skillArtifactStore?: SkillArtifactStore;
  skillContext?: {
    appId: string;
    agentId: string;
  };
  mcpServerRepository?: McpServerRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  mcpContext?: {
    appId: string;
    agentId: string;
  };
  mcpHostnameLookup?: HostnameLookup;
  mcpDnsValidationCache?: RemoteMcpDnsValidationCache;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
  executionAdapter?: AgentExecutionAdapter;
  executionAdapters?: AgentExecutionAdapterRegistry;
  warmPool?: WarmPoolRuntime;
  warmPoolPrewarmOnly?: boolean;
}

export interface HostRuntimeContext {
  groupDir: string;
  groupIpcDir: string;
  runnerDistDir: string;
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export interface RunnerProcessSpec {
  group: ConversationRoute;
  input: AgentInput;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv | undefined;
  onProcess: (
    proc: ChildProcess,
    runHandle: string,
    metadata?: AgentProcessMetadata,
  ) => void;
  onOutput?: (output: AgentOutput) => Promise<void>;
  options?: RunAgentOptions;
  runnerLabel: string;
  processName: string;
  startTime: number;
  logsDir: string;
  runtimeDetails: string[];
  boundProcess?: ChildProcess;
  inputDelivery?: 'stdin' | 'external';
  registeredRunHandle?: string;
  processMetadata?: AgentProcessMetadata;
  resolveOnTerminalOutput?: boolean;
}
