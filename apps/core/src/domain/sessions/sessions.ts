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
  providerRef: ExternalRef<'provider_session'>;
  status: 'active' | 'expired' | 'reset';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
