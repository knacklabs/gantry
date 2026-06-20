import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import type { AgentPersona } from '../../../../shared/agent-persona.js';
import type { PromptSurface } from '../../../../shared/prompt-surface.js';
import type { YoloModeSettings } from '../../../../shared/yolo-mode-policy.js';
import type { CapabilityRuntimeAccess } from '../../../../shared/capability-runtime-access.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';

export interface AgentRunnerInput {
  prompt: string;
  runMode?: 'prime' | 'execute';
  appId?: string;
  agentId?: string;
  sessionId?: string;
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
  runId?: string;
  assistantName?: string;
  compiledSystemPrompt?: string;
  guardrailSystemPromptAppend?: string;
  memoryContextBlock?: string;
  /**
   * Warm-pool (Pillar 2, F3): boot this worker GENERIC (no customer identity /
   * first message at boot) via the SDK `startup()` primitive, then await a BIND
   * over a non-stdin channel before running. Default off ⇒ today's cold path.
   */
  warmGenericBoot?: boolean;
  yoloMode?: YoloModeSettings;
  modelCredentialEnv?: Record<string, string>;
  runtimeAccess?: CapabilityRuntimeAccess[];
  thinking?: {
    mode: 'adaptive' | 'enabled' | 'disabled';
    effort?: EffortLevel;
    budgetTokens?: number;
    display?: 'summarized' | 'omitted';
  };
}

/**
 * One main-LLM assistant turn, captured per `assistant` SDK message. Carried in
 * the stdout output envelope to core, where it becomes an `llm` latency stage.
 * Structurally mirrors the runtime-side `LlmTurnRecord` (the only link between
 * them is the JSON envelope; no compile-time coupling across the layer).
 */
export interface AgentRunnerLlmTurn {
  ms: number;
  /** Wall-clock start (ms epoch) of the turn (first assistant byte). */
  startedAt: number;
  detail: {
    model?: string;
    stopReason?: string;
    tokens?: { in: number; out: number; cacheRead: number; cacheWrite: number };
  };
  /** Full assembled input — only when payload capture is enabled. */
  input?: unknown;
  /** Full output text — only when payload capture is enabled. */
  output?: string;
}

/**
 * One SDK-observed tool execution span. Core can also record Gantry MCP proxy
 * calls; this runner-side span is a fallback for SDK/direct-MCP tool paths that
 * otherwise appear only as a gap between assistant turns.
 */
export interface AgentRunnerToolCall {
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

export interface AgentRunnerOutput {
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
  runtimeEvents?: AgentRunnerRuntimeEventOutput[];
  primeToolAttempts?: AgentRunnerToolAttemptOutput[];
  /** Per-turn LLM timing + usage for the latency trace (best-effort). */
  turns?: AgentRunnerLlmTurn[];
  /** SDK/direct-MCP tool spans for the latency trace (best-effort). */
  toolCalls?: AgentRunnerToolCall[];
  /** Run-level process-startup marks for the latency timeline (best-effort). */
  runnerStartup?: { queryDispatchedAt?: number; firstSdkMessageAt: number };
  /** Warm continuation: when this reply's input was delivered to the model. */
  dispatchedAt?: number;
}

export interface AgentRunnerToolAttemptOutput {
  runMode: 'prime';
  requestedToolName: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolUseID?: string;
  agentID?: string;
  toolInput?: unknown;
  suggestions?: unknown[];
  deniedReason: string;
}

export interface RunnerCapabilitiesForPermission {
  allowedTools: readonly string[];
  alwaysAllowedTools: readonly string[];
}

export interface AgentRunnerRuntimeEventOutput {
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

export interface PermissionDecision {
  approved: boolean;
  mode?:
    | 'allow_once'
    | 'allow_persistent_rule'
    | 'allow_timed_grant'
    | 'cancel';
  decidedBy?: string;
  reason?: string;
  updatedPermissions?: unknown[];
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
  timedGrantExpiresAtMs?: number;
}

export interface SessionSlashCommand {
  command: string;
  kind: 'model';
}
