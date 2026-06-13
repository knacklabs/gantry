import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import type { AgentPersona } from '../../../../shared/agent-persona.js';
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
