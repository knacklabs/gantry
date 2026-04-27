import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../conversation/conversation.js';
import type { JobId } from '../jobs/jobs.js';
import type { BrandedId, ExternalRef } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type AgentSessionId = BrandedId<'AgentSessionId'>;
export type ProviderSessionId = BrandedId<'ProviderSessionId'>;
export type AgentSessionSummaryId = BrandedId<'AgentSessionSummaryId'>;

export interface AgentSession {
  id: AgentSessionId;
  appId: AppId;
  agentId: AgentId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  jobId?: JobId;
  userId?: UserId;
  status: 'active' | 'reset' | 'archived';
  modelOverride?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  resetAt?: IsoTimestamp;
}

export interface ProviderSession {
  id: ProviderSessionId;
  appId: AppId;
  agentSessionId: AgentSessionId;
  provider: string;
  externalSessionId: string;
  artifactRef?: string;
  providerRef: ExternalRef<'provider_session'>;
  metadata?: Record<string, unknown>;
  status: 'active' | 'expired' | 'reset';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface AgentSessionSummary {
  id: AgentSessionSummaryId;
  appId: AppId;
  agentSessionId: AgentSessionId;
  summary: string;
  source: 'extractive';
  fromMessageId?: string;
  toMessageId?: string;
  fromRunId?: string;
  toRunId?: string;
  messageCount: number;
  runCount: number;
  createdAt: IsoTimestamp;
}
