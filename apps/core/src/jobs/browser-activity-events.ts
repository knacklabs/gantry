import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { Job } from '../domain/types.js';
import {
  resolveAppSessionForJob,
  type SchedulerEventAppSession,
} from './app-session-resolution.js';
import { terminalToolActivityPayload } from '../domain/events/tool-activity.js';

interface RuntimeControlSessionReader {
  getAppSessionById(
    sessionId: string,
  ): Promise<SchedulerEventAppSession | null | undefined>;
}

export interface BrowserJobActivityInput {
  invocationId: string;
  appId?: string;
  agentId?: string;
  conversationId: string;
  threadId?: string;
  jobId?: string;
  runId: string;
  tool: string;
  publicToolName?: string | null;
  action?: string | null;
  ok: boolean;
  elapsedMs: number;
  normalizedSite?: string | null;
  policyMode?: string | null;
  warning?: string | null;
  error?: string | null;
}

export async function publishBrowserJobActivityEvent(input: {
  activity: BrowserJobActivityInput;
  getJobById: (jobId: string) => Promise<Pick<Job, 'session_id'> | undefined>;
  controlRepository: RuntimeControlSessionReader;
  publishRuntimeEvent: (
    event: RuntimeEventPublishInput,
  ) => Promise<void> | void;
  runtimeAppId?: string;
  logger?: {
    warn(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<void> {
  const log = input.logger ?? NOOP_LOGGER;
  const activity = input.activity;
  const runtimeAppId = input.runtimeAppId ?? DEFAULT_JOB_RUNTIME_APP_ID;
  let eventAppSession: SchedulerEventAppSession | undefined;
  try {
    const job = activity.jobId
      ? await input.getJobById(activity.jobId)
      : undefined;
    if (job) {
      eventAppSession = await resolveAppSessionForJob(
        job,
        input.controlRepository,
      );
    }
  } catch (err) {
    log.warn(
      { err, jobId: activity.jobId, runId: activity.runId },
      'Failed to resolve app session for browser job activity event',
    );
  }

  await input.publishRuntimeEvent({
    appId: (eventAppSession?.appId ?? activity.appId ?? runtimeAppId) as never,
    ...(activity.agentId ? { agentId: activity.agentId as never } : {}),
    eventType: RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
    actor: 'browser',
    correlationId: activity.invocationId,
    sessionId: eventAppSession?.sessionId as never,
    ...(activity.jobId ? { jobId: activity.jobId as never } : {}),
    runId: activity.runId as never,
    conversationId: activity.conversationId as never,
    ...(activity.threadId ? { threadId: activity.threadId as never } : {}),
    responseMode: eventAppSession?.defaultResponseMode,
    webhookId: eventAppSession?.defaultWebhookId,
    payload: terminalToolActivityPayload({
      invocationId: activity.invocationId,
      tool: activity.publicToolName ?? activity.action ?? activity.tool,
      family: 'browser',
      outcome: activity.ok ? 'success' : 'failure',
      authoritative: true,
      detail:
        activity.error ??
        activity.warning ??
        activity.normalizedSite ??
        undefined,
    }),
  });
}

const NOOP_LOGGER = {
  warn: () => undefined,
};
