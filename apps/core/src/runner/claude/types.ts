import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { NormalizedModelUsage } from '../../shared/model-catalog.js';

export interface AgentRunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  threadId?: string;
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
  error?: string;
}

export interface PermissionDecision {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
}

export interface SessionSlashCommand {
  command: string;
  kind: 'model';
}
