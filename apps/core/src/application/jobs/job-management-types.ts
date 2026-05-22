import type {
  Job,
  JobCapabilityRequirement,
  JobEvent,
  JobRun,
  JobScheduleType,
} from '../../domain/types.js';
import type {
  CapabilitySecretRepository,
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import type {
  RuntimeEventFilter,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import type {
  JobUpsertInput,
  RuntimeJobRepository,
} from '../../domain/repositories/ops-repo.js';
import type { Clock } from '../common/clock.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';
import type { JobReadinessBrowserStatus } from './job-readiness-service.js';

export type JobKind = 'manual' | 'once' | 'recurring';

export interface JobExecutionContextInput {
  conversationJid: string;
  threadId: string | null;
  groupScope: string;
  sessionId?: string | null;
}

export interface JobNotificationRouteInput {
  conversationJid: string;
  threadId: string | null;
  label: string;
}

export interface AppSessionRecord {
  sessionId: string;
  appId: string;
  conversationJid: string;
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
  getAppSessionsByIds(
    sessionIds: readonly string[],
  ): Promise<AppSessionRecord[]>;
  getAppSessionByChatJid(
    conversationJid: string,
  ): Promise<AppSessionRecord | undefined>;
  getAppSessionsByChatJids?(
    conversationJids: readonly string[],
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
  ops: RuntimeJobRepository;
  scheduler: SchedulerCoordinationPort;
  schedulePlanner: JobSchedulePlanner;
  clock?: Clock;
  control?: JobControlPort;
  runtimeEvents?: RuntimeEventPublisherPort;
  triggerQueue?: JobTriggerQueuePort;
  toolRepository?: ToolCatalogRepository;
  skillRepository?: SkillCatalogRepository;
  mcpServerRepository?: McpServerRepository;
  capabilitySecretRepository?: CapabilitySecretRepository;
  getCredentialBroker?: () => Promise<AgentCredentialBroker | undefined>;
  getBrowserStatus?: (
    profileName: string,
  ) => Promise<JobReadinessBrowserStatus | undefined>;
}

export interface CreateManagedJobInput {
  appId: string;
  name: string;
  prompt: string;
  sessionId: string;
  executionContext?: JobExecutionContextInput;
  notificationRoutes?: JobNotificationRouteInput[];
  capabilityRequirements?: JobCapabilityRequirement[];
  toolAccessRequirements?: string[];
  requiredMcpServers?: string[];
  kind?: JobKind;
  runAt?: string;
  schedule?: { type?: unknown; value?: unknown };
  modelAlias?: unknown;
  dryRun?: unknown;
}

export interface UpsertJobFromIpcInput {
  access: SchedulerJobAccess;
  jobId?: string;
  name: string;
  prompt: string;
  modelAlias?: string | null;
  scheduleType: unknown;
  scheduleValue: string;
  executionContext?: JobExecutionContextInput;
  notificationRoutes?: JobNotificationRouteInput[];
  capabilityRequirements?: JobCapabilityRequirement[];
  toolAccessRequirements?: string[];
  requiredMcpServers?: string[];
  threadId?: string;
  silent?: boolean;
  cleanupAfterMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  groupScope?: string;
  createdBy?: 'agent' | 'human';
}

export interface ConversationBinding {
  folder: string;
  name?: string;
  conversationKind?: 'dm' | 'channel';
}

export interface SchedulerJobAccess {
  sourceAgentFolder: string;
  originConversationJid: string;
  conversationBindings: Record<string, ConversationBinding>;
  sourceConversationJids?: string[];
  authThreadId?: string;
}

export type JobUpdatePatch = Partial<{
  name: string;
  prompt: string;
  model: string | null;
  scheduleType: JobScheduleType;
  scheduleValue: string;
  executionContext: JobExecutionContextInput;
  notificationRoutes: JobNotificationRouteInput[];
  capabilityRequirements: JobCapabilityRequirement[];
  toolAccessRequirements: string[];
  requiredMcpServers: string[];
  threadId: string | null;
  groupScope: string;
  silent: boolean;
  cleanupAfterMs: number;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  maxConsecutiveFailures: number;
  status: Extract<Job['status'], 'active' | 'paused'>;
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

export type ManagedJobLookupInput = JobLookupInput;

export interface ManagedJobListInput extends JobListInput {
  limit?: number;
}

export interface ManagedJobUpdateInput extends JobLookupInput {
  patch: JobUpdatePatch;
}

export type ManagedJobDeleteInput = JobLookupInput;

export interface ManagedJobPauseInput extends JobLookupInput {
  reason?: string;
}

export interface ManagedJobResumeInput extends JobLookupInput {
  invalidSchedulePolicy?: 'resume_now' | 'dead_letter';
}

export interface ManagedJobTriggerInput {
  appId: string;
  jobId: string;
  consumeRateLimit?: (key: string, limit: number) => boolean;
  perAppLimit: number;
  perJobLimit: number;
}

export interface ManagedJobTriggerWaitInput {
  appId: string;
  triggerId: string;
  timeoutMs: number;
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

export type { Job, JobEvent, JobRun, JobScheduleType };
export type { JobUpsertInput };
