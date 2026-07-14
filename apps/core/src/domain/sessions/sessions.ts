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
export type ExecutionProviderId = BrandedId<'ExecutionProviderId'>;
export type AgentSessionSummaryId = BrandedId<'AgentSessionSummaryId'>;
export type AgentSessionDigestId = BrandedId<'AgentSessionDigestId'>;

export interface AgentSession {
  id: AgentSessionId;
  appId: AppId;
  agentId: AgentId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  jobId?: JobId;
  userId?: UserId;
  status: 'active' | 'reset' | 'archived';
  model?: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  resetAt?: IsoTimestamp;
}

export interface ProviderSession {
  id: ProviderSessionId;
  appId: AppId;
  agentSessionId: AgentSessionId;
  provider: ExecutionProviderId;
  externalSessionId: string;
  providerRef: ExternalRef<'provider_session'>;
  metadata?: Record<string, unknown>;
  status: 'active' | 'expired' | 'reset' | 'maintenance_compact' | 'ready';
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

export interface AgentSessionDigest {
  id: AgentSessionDigestId;
  appId: AppId;
  agentSessionId: AgentSessionId;
  trigger: 'precompact' | 'session-end';
  digest: string;
  messageCount: number;
  extractedFactCount: number;
  metadata?: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

export type AgentSessionDigestScopeMetadata = {
  sessionScope: {
    appId: string | null;
    agentId: string | null;
    conversationId: string | null;
    userId: string | null;
    threadId: string | null;
    jobId: string | null;
  };
};

export function scopedDigestMetadataForSession(
  session: AgentSession,
): AgentSessionDigestScopeMetadata {
  return {
    sessionScope: {
      appId: scopedSessionValue(session.appId),
      agentId: scopedSessionValue(session.agentId),
      conversationId: scopedSessionValue(session.conversationId),
      userId: scopedSessionValue(session.userId),
      threadId: scopedSessionValue(session.threadId),
      jobId: scopedSessionValue(session.jobId),
    },
  };
}

function scopedSessionValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
