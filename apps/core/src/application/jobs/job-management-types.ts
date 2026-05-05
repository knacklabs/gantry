import type {
  Job,
  JobEvent,
  JobExecutionMode,
  JobRun,
  JobScheduleType,
} from '../../domain/types.js';
import type {
  RuntimeEventFilter,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import type {
  JobUpsertInput,
  OpsRepository,
} from '../../domain/repositories/ops-repo.js';
import type { ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { Clock } from '../common/clock.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';

export type JobKind = 'manual' | 'once' | 'recurring';

export interface AppSessionRecord {
  sessionId: string;
  appId: string;
  chatJid: string;
  workspaceKey: string;
  defaultResponseMode: RuntimeEventPublishInput['responseMode'];
  defaultWebhookId: string | null;
}

export interface JobTriggerRecord {
  triggerId: string;
  jobId: string;
  runId: string | null;
  status: string;
}

export interface JobControlPort {
  getAppSessionById(sessionId: string): Promise<AppSessionRecord | undefined>;
  getAppSessionByChatJid(
    chatJid: string,
  ): Promise<AppSessionRecord | undefined>;
  getAppSessionsByChatJids?(
    chatJids: readonly string[],
  ): Promise<AppSessionRecord[]>;
  createJobTrigger(input: {
    jobId: string;
    // Opaque audit string. SDK triggers use JSON `{kind:"sdk",...}`;
    // MCP triggers use JSON `{kind:"mcp",...}`. Queryable auth fields belong
    // on job/session records, not in this free-form trigger column.
    requestedBy?: string;
  }): Promise<JobTriggerRecord>;
  markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void>;
  getTriggerById(triggerId: string): Promise<JobTriggerRecord | undefined>;
}

export interface RuntimeEventPublisherPort {
  publish(input: RuntimeEventPublishInput): Promise<unknown>;
  subscribe?(filter: RuntimeEventFilter): {
    next(options?: { timeoutMs?: number }): Promise<unknown[]>;
    close(): void;
  };
}

export interface JobTriggerQueuePort {
  isReady(): boolean;
  enqueue(
    jobId: string,
    triggerId: string,
    options?: { runId?: string },
  ): Promise<void>;
}

export interface JobSchedulePlan {
  scheduleType: JobScheduleType;
  scheduleValue: string;
  nextRun: string | null;
}

export interface JobSchedulePlanner {
  createManualJobId(): string;
  createJobId(input: {
    name: string;
    prompt: string;
    scheduleType: string;
    scheduleValue: string;
    groupScope: string;
  }): string;
  planAppSchedule(input: {
    kind: JobKind;
    runAt: unknown;
    schedule?: { type?: unknown; value?: unknown };
  }): JobSchedulePlan;
  planInitial(input: {
    scheduleType: Exclude<JobScheduleType, 'manual'>;
    scheduleValue: string;
  }): { nextRun: string };
  planResume(input: { job: Job; clock: Clock }): string | null | undefined;
}

export interface JobManagementServiceDeps {
  ops: OpsRepository;
  scheduler: SchedulerCoordinationPort;
  schedulePlanner: JobSchedulePlanner;
  clock?: Clock;
  toolRepository?: ToolCatalogRepository;
  approveJobExtraTools?: (input: JobExtraToolApprovalRequest) => Promise<{
    approved: boolean;
    reason?: string;
  }>;
  control?: JobControlPort;
  runtimeEvents?: RuntimeEventPublisherPort;
  triggerQueue?: JobTriggerQueuePort;
}

export interface JobExtraToolApprovalRequest {
  jobId: string;
  jobName: string;
  target: {
    appId: string;
    agentId: string;
    groupScope: string;
  };
  inheritedTools: string[];
  requestedJobExtraTools: string[];
  extrasBeyondInherited: string[];
  existingJobExtraTools: string[];
  operation: 'create' | 'update';
}

export interface CreateManagedJobInput {
  appId: string;
  name: string;
  prompt: string;
  sessionId: string;
  kind?: JobKind;
  runAt?: string;
  schedule?: { type?: unknown; value?: unknown };
  executionMode?: unknown;
  threadId?: unknown;
  modelAlias?: unknown;
  modelProfileId?: unknown;
  allowedTools?: unknown;
  dryRun?: unknown;
}

export interface UpsertJobFromIpcInput {
  access: SchedulerJobAccess;
  jobId?: string;
  name: string;
  prompt: string;
  modelAlias?: string | null;
  modelProfileId?: string | null;
  scheduleType: unknown;
  scheduleValue: string;
  linkedSessions?: string[];
  deliverTo?: string[];
  threadId?: string;
  silent?: boolean;
  cleanupAfterMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  executionMode?: unknown;
  serialize?: unknown;
  groupScope?: string;
  createdBy?: 'agent' | 'human';
  allowedTools?: unknown;
}

export interface ConversationBinding {
  folder: string;
}

export interface SchedulerJobAccess {
  sourceGroup: string;
  originConversationJid: string;
  // Main-agent status does not widen scheduler job visibility or mutation.
  isMain: boolean;
  conversationBindings: Record<string, ConversationBinding>;
  sourceGroupJids?: string[];
  authThreadId?: string;
}

export type JobUpdatePatch = Partial<{
  name: string;
  prompt: string;
  model: string | null;
  scheduleType: JobScheduleType;
  scheduleValue: string;
  linkedSessions: string[];
  threadId: string | null;
  groupScope: string;
  silent: boolean;
  cleanupAfterMs: number;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  maxConsecutiveFailures: number;
  executionMode: JobExecutionMode;
  status: Extract<Job['status'], 'active' | 'paused'>;
  allowedTools: string[];
}>;

export interface JobListInput {
  appId?: string;
  access?: SchedulerJobAccess;
  statuses?: string[];
  groupScope?: string;
  agentId?: string;
  kind?: JobKind;
  conversationJid?: string;
}

export interface JobLookupInput {
  jobId: string;
  appId?: string;
  access?: SchedulerJobAccess;
}

export interface JobRunListInput {
  appId?: string;
  access?: SchedulerJobAccess;
  jobId?: string;
  limit?: number;
}

export interface JobEventListInput extends JobRunListInput {
  runId?: string;
  eventType?: string;
  sinceId?: number;
  since?: string;
}

export interface SchedulerRunNowInput {
  jobId: string;
  access: SchedulerJobAccess;
  runId: string;
}

export type { Job, JobEvent, JobExecutionMode, JobRun, JobScheduleType };
export type { JobUpsertInput };
