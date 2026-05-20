import type {
  AgentConfigVersionId,
  AgentId,
  LlmProfileId,
} from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';
import type { JobId } from '../jobs/jobs.js';
import type { MessageId } from '../messages/messages.js';
import type { PermissionDecisionId } from '../permissions/permissions.js';
import type {
  SandboxLeaseId,
  WorkspaceSnapshotId,
} from '../sandbox/sandbox.js';
import type {
  AgentSessionId,
  ExecutionProviderId,
  ProviderSessionId,
} from '../sessions/sessions.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { RuntimeEventType } from './runtime-event-types.js';

export type AgentRunId = BrandedId<'AgentRunId'>;
export type RuntimeEventId = number & {
  readonly __brand: 'RuntimeEventId';
};

export type RuntimeResponseMode = 'sse' | 'webhook' | 'both' | 'none';

export interface RuntimeEvent {
  eventId: RuntimeEventId;
  appId: AppId;
  agentId?: AgentId;
  sessionId?: AgentSessionId;
  runId?: AgentRunId;
  jobId?: JobId;
  triggerId?: string;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  eventType: RuntimeEventType;
  actor: string;
  correlationId?: string;
  responseMode?: RuntimeResponseMode;
  webhookId?: string;
  payload: unknown;
  createdAt: IsoTimestamp;
}

export interface RuntimeEventPublishInput {
  appId: AppId;
  agentId?: AgentId;
  sessionId?: AgentSessionId;
  runId?: AgentRunId;
  jobId?: JobId;
  triggerId?: string;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  eventType: RuntimeEventType;
  actor: string;
  correlationId?: string | null;
  responseMode?: RuntimeResponseMode | null;
  webhookId?: string | null;
  payload: unknown;
  createdAt?: IsoTimestamp;
}

export interface RuntimeEventFilter {
  appId: AppId;
  afterEventId?: RuntimeEventId;
  sessionId?: AgentSessionId;
  runId?: AgentRunId;
  jobId?: JobId;
  triggerId?: string;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  eventTypes?: RuntimeEventType[];
  limit?: number;
}

export interface AgentRun {
  id: AgentRunId;
  appId: AppId;
  agentId: AgentId;
  configVersionId: AgentConfigVersionId;
  sessionId?: AgentSessionId;
  conversationId?: ConversationId;
  threadId?: ConversationThreadId;
  messageId?: MessageId;
  jobId?: JobId;
  llmProfileId: LlmProfileId;
  executionProviderId: ExecutionProviderId;
  providerRunId?: string;
  providerSessionId?: ProviderSessionId;
  workerId?: string;
  leaseOwner?: string;
  leaseExpiresAt?: IsoTimestamp;
  permissionDecisionIds: PermissionDecisionId[];
  sandboxLeaseId?: SandboxLeaseId;
  workspaceSnapshotId?: WorkspaceSnapshotId;
  cause: 'message' | 'job' | 'control' | 'manual';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  createdAt: IsoTimestamp;
  startedAt?: IsoTimestamp;
  endedAt?: IsoTimestamp;
  resultSummary?: string;
  errorSummary?: string;
}
