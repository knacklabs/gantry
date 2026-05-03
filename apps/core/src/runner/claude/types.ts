import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type {
  NormalizedModelUsage,
  RuntimeContextUsageSnapshot,
} from '../../shared/model-catalog.js';
import type { AgentPersona } from '../../shared/agent-persona.js';

export interface AgentRunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: 'user' | 'group';
  persona?: AgentPersona;
  browserProfileName?: string;
  allowedTools?: string[];
  isMain: boolean;
  isScheduledJob?: boolean;
  assistantName?: string;
  script?: string;
  compiledSystemPrompt?: string;
  memoryContextBlock?: string;
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
  usage?: NormalizedModelUsage;
  usageEventId?: string;
  contextUsage?: RuntimeContextUsageSnapshot;
  error?: string;
}

export interface PermissionDecision {
  approved: boolean;
  mode?: 'allow_once' | 'allow_persistent_rule' | 'cancel';
  decidedBy?: string;
  reason?: string;
  updatedPermissions?: unknown[];
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
}

export interface SessionSlashCommand {
  command: string;
  kind: 'model';
}
