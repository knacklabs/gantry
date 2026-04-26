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
import type { AgentSessionId } from '../sessions/sessions.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type AgentRunId = BrandedId<'AgentRunId'>;
export type AgentRunEventId = BrandedId<'AgentRunEventId'>;

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

export interface AgentRunEvent {
  id: AgentRunEventId;
  appId: AppId;
  runId: AgentRunId;
  type:
    | 'queued'
    | 'started'
    | 'model_event'
    | 'tool_request'
    | 'permission_decision'
    | 'output_chunk'
    | 'completed'
    | 'failed'
    | 'canceled';
  payload: unknown;
  createdAt: IsoTimestamp;
}
