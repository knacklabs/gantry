import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../conversation/conversation.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type MemoryItemId = BrandedId<'MemoryItemId'>;

export type MemorySubject =
  | { kind: 'app'; appId: AppId }
  | { kind: 'agent'; appId: AppId; agentId: AgentId }
  | { kind: 'user'; appId: AppId; userId: UserId }
  | { kind: 'conversation'; appId: AppId; conversationId: ConversationId }
  | {
      kind: 'thread';
      appId: AppId;
      conversationId: ConversationId;
      threadId: ConversationThreadId;
    };

export interface MemoryItem {
  id: MemoryItemId;
  appId: AppId;
  agentId?: AgentId;
  subject: MemorySubject;
  kind: 'fact' | 'preference' | 'decision' | 'procedure' | 'correction';
  key: string;
  value: string;
  source: string;
  confidence: number;
  isPinned: boolean;
  isDeleted: boolean;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
