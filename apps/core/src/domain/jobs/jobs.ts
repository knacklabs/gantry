import type { AgentId } from '../agent/agent.js';
import type { AppId } from '../app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
  UserId,
} from '../conversation/conversation.js';
import type { AgentRunId } from '../events/events.js';
import type { AgentSessionId } from '../sessions/sessions.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { DurationMs, IsoTimestamp } from '../../shared/time/primitives.js';

export type JobId = BrandedId<'JobId'>;

export type JobSchedule =
  | { kind: 'manual' }
  | { kind: 'cron'; expression: string }
  | { kind: 'interval'; intervalMs: DurationMs }
  | { kind: 'once'; runAt: IsoTimestamp };

export interface Job {
  id: JobId;
  appId: AppId;
  agentId: AgentId;
  name: string;
  prompt: string;
  modelOverride?: string;
  schedule: JobSchedule;
  status: 'active' | 'paused' | 'running' | 'completed' | 'dead_lettered';
  executionMode: 'parallel' | 'serialized';
  target?: {
    sessionId?: AgentSessionId;
    conversationId?: ConversationId;
    threadId?: ConversationThreadId;
    userId?: UserId;
  };
  silent: boolean;
  timeoutMs: DurationMs;
  maxRetries: number;
  retryBackoffMs: DurationMs;
  nextRunAt?: IsoTimestamp;
  lastRunAt?: IsoTimestamp;
  leaseRunId?: AgentRunId;
  leaseExpiresAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface JobTrigger {
  id: BrandedId<'JobTriggerId'>;
  appId: AppId;
  jobId: JobId;
  runId?: AgentRunId;
  requestedBy: UserId | 'runtime' | 'sdk';
  requestedAt: IsoTimestamp;
  status: 'pending' | 'claimed' | 'completed' | 'failed';
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
