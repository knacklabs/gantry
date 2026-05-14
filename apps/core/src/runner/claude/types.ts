import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../shared/model-catalog.js';
import type { AgentPersona } from '../../shared/agent-persona.js';

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
  selectedSkillIds?: string[];
  selectedMcpServerIds?: string[];
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  assistantName?: string;
  compiledSystemPrompt?: string;
  memoryContextBlock?: string;
  modelCredentialEnv?: Record<string, string>;
  thinking?: {
    mode: 'adaptive' | 'enabled' | 'disabled';
    effort?: EffortLevel;
    budgetTokens?: number;
    display?: 'summarized' | 'omitted';
  };
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
