import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type { ConversationId, UserId } from '../conversation/conversation.js';

export interface MemorySubjectRoute {
  trigger?: string;
  requiresTrigger?: boolean;
  agentConfig?: unknown;
}

export type MemorySubject = (
  | { kind: 'app'; appId: AppId }
  | { kind: 'agent'; appId: AppId; agentId: AgentId }
  | { kind: 'user'; appId: AppId; userId: UserId }
  | { kind: 'conversation'; appId: AppId; conversationId: ConversationId }
) & { route?: MemorySubjectRoute };
