import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { Job } from '../domain/types.js';
import {
  resolveAppSessionForJob,
  type SchedulerEventAppSession,
} from './app-session-resolution.js';

interface RuntimeControlSessionReader {
  getAppSessionById(
    sessionId: string,
  ): Promise<SchedulerEventAppSession | null | undefined>;
}

export interface BrowserJobActivityInput {
  jobId: string;
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
    const job = await input.getJobById(activity.jobId);
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
    appId: (eventAppSession?.appId ?? runtimeAppId) as never,
    eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
    actor: 'browser',
    sessionId: eventAppSession?.sessionId as never,
    jobId: activity.jobId as never,
    runId: activity.runId as never,
    responseMode: eventAppSession?.defaultResponseMode,
    webhookId: eventAppSession?.defaultWebhookId,
    payload: {
      tool: activity.tool,
      public_tool: activity.publicToolName ?? null,
      action: activity.action ?? null,
      ok: activity.ok,
      elapsed_ms: activity.elapsedMs,
      normalized_site: activity.normalizedSite ?? null,
      policy_mode: activity.policyMode ?? null,
      warning: activity.warning ?? null,
      error: activity.error ?? null,
    },
  });
}

const NOOP_LOGGER = {
  warn: () => undefined,
};
