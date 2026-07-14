import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../../../shared/model-catalog.js';
import type { AgentPersona } from '../../../../shared/agent-persona.js';
import type { YoloModeSettings } from '../../../../shared/yolo-mode-policy.js';
import type { CapabilityRuntimeAccess } from '../../../../shared/capability-runtime-access.js';
import type { SemanticCapabilityDefinition } from '../../../../shared/semantic-capabilities.js';
import type { GantryAgentPromptMode } from '../../../../runner/gantry-agent-system-prompt.js';

export interface AgentRunnerInput {
  prompt: string;
  runMode?: 'prime' | 'execute';
  appId?: string;
  agentId?: string;
  sessionId?: string;
  workspaceFolder: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  memoryReviewerIsControlApprover?: boolean;
  persona?: AgentPersona;
  browserProfileName?: string;
  allowedTools?: string[];
  toolAccessRequirements?: string[];
  attachedSkillSourceIds?: string[];
  selectedSkillDisplays?: string[];
  attachedMcpSourceIds?: string[];
  semanticCapabilities?: SemanticCapabilityDefinition[];
  hideAuthorityTools?: boolean;
  isScheduledJob?: boolean;
  jobId?: string;
  runId?: string;
  parentTaskId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  assistantName?: string;
  promptMode?: GantryAgentPromptMode;
  compiledSystemPrompt?: string;
  memoryContextBlock?: string;
  yoloMode?: YoloModeSettings;
  modelCredentialEnv?: Record<string, string>;
  toolNetworkEnv?: Record<string, string>;
  runtimeAccess?: CapabilityRuntimeAccess[];
  thinking?: {
    mode: 'adaptive' | 'enabled' | 'disabled';
    effort?: EffortLevel;
    budgetTokens?: number;
    display?: 'summarized' | 'omitted';
  };
  effort?: EffortLevel;
  configuredThinking?:
    | { mode: 'off'; budgetTokens?: never }
    | { mode: 'on'; budgetTokens?: number };
}

export interface AgentRunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  runtimeEventOnly?: boolean;
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

export interface RunnerCapabilitiesForPermission {
  allowedTools: readonly string[];
  alwaysAllowedTools: readonly string[];
  permissionMode: 'default' | 'deny';
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

// Single source of truth for the permission-IPC workspace-folder option key.
// Composed via string concatenation so a literal "workspaceFolder" never appears
// verbatim in the bundle; the send (tool-permission-gate) and read
// (permission-callback) sides MUST share this constant or the IPC silently
// breaks (key mismatch is not a TS error across the string-concat boundary).
export const WORKSPACE_FOLDER_OPTION_KEY = `${'workspace'}${'Folder'}` as const;
