import type {
  Job,
  JobEvent,
  JobExecutionMode,
  JobRun,
  JobScheduleType,
} from '../../domain/types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type {
  JobUpsertInput,
  OpsRepository,
} from '../../domain/repositories/ops-repo.js';
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
  createJobTrigger(input: {
    jobId: string;
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
}

export interface JobTriggerQueuePort {
  isReady(): boolean;
  enqueue(jobId: string, triggerId: string): Promise<void>;
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
  control?: JobControlPort;
  runtimeEvents?: RuntimeEventPublisherPort;
  triggerQueue?: JobTriggerQueuePort;
}

export interface ConversationBinding {
  folder: string;
}

export interface SchedulerJobAccess {
  sourceGroup: string;
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
}>;

export interface JobListInput {
  appId?: string;
  access?: SchedulerJobAccess;
  statuses?: string[];
  groupScope?: string;
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

export type { Job, JobEvent, JobExecutionMode, JobRun, JobScheduleType };
export type { JobUpsertInput };
