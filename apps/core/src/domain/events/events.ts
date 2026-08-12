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

// Synthetic run-ids are minted for LLM calls that have no `agent_runs` row
// (permission classification, memory queries, credential brokering). A real
// run id is either `agent-run:<uuid>` or a bare uuid — both satisfy the
// runtime_events -> agent_runs FK; these prefixes never do, so audit writes
// must drop them. Every synthetic minter MUST register its prefix here: the
// permission-classifier LLM client, the per-provider memory-query and
// chat-batch clients, and the spawn-host / turn-tracker credential minters.
export const SYNTHETIC_RUN_ID_PREFIXES = [
  'permission-classifier:',
  'memory-query:',
  'credential-run:',
] as const;

export function isSyntheticRunId(runId: string): boolean {
  return SYNTHETIC_RUN_ID_PREFIXES.some((prefix) => runId.startsWith(prefix));
}
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
  /**
   * Any of these conversation ids, OR-ed. One jid can map to several
   * conversation rows — the runtime warns
   * `conversation_route_conversation_id_noncanonical` for routes that predate
   * the canonical id — so a single-id filter silently hides events recorded
   * under the older one.
   */
  conversationIds?: ConversationId[];
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
  /**
   * Any of these conversation ids, OR-ed. One jid can map to several
   * conversation rows — the runtime warns
   * `conversation_route_conversation_id_noncanonical` for routes that predate
   * the canonical id — so a single-id filter silently hides events recorded
   * under the older one.
   */
  conversationIds?: ConversationId[];
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
  /**
   * Any of these conversation ids, OR-ed. One jid can map to several
   * conversation rows — the runtime warns
   * `conversation_route_conversation_id_noncanonical` for routes that predate
   * the canonical id — so a single-id filter silently hides events recorded
   * under the older one.
   */
  conversationIds?: ConversationId[];
  threadId?: ConversationThreadId;
  eventTypes?: RuntimeEventType[];
  limit?: number;
}

export type UsageGroupBy = 'agent' | 'api_key' | 'model' | 'day';

export interface NormalizedUsageEventPayload {
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    estimatedCostUsd?: number;
    model?: string;
    provider?: string;
  };
  modelAlias?: string;
  providerId?: string | null;
  apiKeyId?: string;
  usageEventId?: string;
}

export interface UsageQuery {
  appId: AppId;
  from: IsoTimestamp;
  to: IsoTimestamp;
  agentId?: AgentId;
  apiKeyId?: string;
  runId?: AgentRunId;
  jobId?: JobId;
  model?: string;
  groupBy?: UsageGroupBy;
}

export interface UsageAggregate {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  agentId?: string;
  apiKeyId?: string;
  model?: string;
  day?: string;
}

export type ConsoleMetricRange = '24h' | '7d' | '30d';
export type ConsoleMetricBucket = 'hour' | 'day';
export type ConsoleMetricRunStatus = Extract<
  AgentRun['status'],
  'completed' | 'failed' | 'canceled'
>;

export interface ConsoleMetricUsage {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
}

export interface ConsoleMetricUsageBucket extends ConsoleMetricUsage {
  start: IsoTimestamp;
}

export interface ConsoleMetricModel extends ConsoleMetricUsage {
  model: string;
}

export interface ConsoleMetricsQuery {
  appId: AppId;
  from: IsoTimestamp;
  to: IsoTimestamp;
  bucket: ConsoleMetricBucket;
}

export interface ConsoleMetricsProjection {
  usage: {
    totals: ConsoleMetricUsage;
    buckets: ConsoleMetricUsageBucket[];
    models: ConsoleMetricModel[];
  };
  runs: {
    total: number;
    statuses: Array<{ status: ConsoleMetricRunStatus; count: number }>;
    p95DurationMs?: number;
  };
}

export interface AgentRun {
  id: AgentRunId;
  appId: AppId;
  agentId: AgentId;
  configVersionId: AgentConfigVersionId;
  sessionId?: AgentSessionId;
  conversationId?: ConversationId;
  /**
   * Any of these conversation ids, OR-ed. One jid can map to several
   * conversation rows — the runtime warns
   * `conversation_route_conversation_id_noncanonical` for routes that predate
   * the canonical id — so a single-id filter silently hides events recorded
   * under the older one.
   */
  conversationIds?: ConversationId[];
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
