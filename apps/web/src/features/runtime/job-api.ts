import { z } from 'zod';

import type { RuntimeApiTransport } from '../../lib/api/runtime-transport';

const setupSchema = z
  .object({
    state: z.string(),
    blockers: z
      .array(
        z.object({
          reason: z.string().optional(),
          nextAction: z.string().optional(),
        }),
      )
      .default([]),
  })
  .optional();

const jobSchema = z.object({
  jobId: z.string(),
  name: z.string(),
  promptPreview: z.string().optional(),
  fullPrompt: z.string().optional(),
  kind: z.enum(['manual', 'once', 'recurring']),
  status: z.enum(['active', 'paused', 'deleted']),
  schedule: z
    .object({
      type: z.string().optional(),
      value: z.string().optional(),
      runAt: z.string().optional(),
    })
    .nullable()
    .optional(),
  executionContext: z
    .object({
      conversationJid: z.string(),
      threadId: z.string().nullable().optional(),
      workspaceKey: z.string(),
      sessionId: z.string().nullable().optional(),
    })
    .optional(),
  notificationRoutes: z
    .array(
      z.object({
        conversationJid: z.string(),
        threadId: z.string().nullable().optional(),
        label: z.string().optional(),
      }),
    )
    .default([]),
  setup: setupSchema,
  setupLabel: z.string().optional(),
  nextActionLabel: z.string().nullable().optional(),
  nextRun: z.string().nullable().optional(),
  lastRun: z.string().nullable().optional(),
  workspaceKey: z.string().optional(),
});

const jobListSchema = z.object({ jobs: z.array(jobSchema) });

const runSchema = z.object({
  run_id: z.string(),
  job_id: z.string(),
  status: z.string(),
  started_at: z.string().optional(),
  completed_at: z.string().nullable().optional(),
});

const runListSchema = z.object({ runs: z.array(runSchema) });
const runEventListSchema = z.object({
  events: z.array(
    z.object({
      eventId: z.number().int(),
      eventType: z.string(),
      createdAt: z.string(),
    }),
  ),
});

const mutationResponseSchema = z.record(z.string(), z.unknown());

export type JobView = {
  id: string;
  name: string;
  description: string;
  agent: string;
  status: 'enabled' | 'paused' | 'blocked';
  canonicalStatus: 'active' | 'paused' | 'deleted';
  kind: 'manual' | 'once' | 'recurring';
  schedule: string;
  nextRun: string;
  notificationRoutes: string[];
  blocker?: { summary: string; action: string };
  prompt: string;
  executionContext?: z.infer<typeof jobSchema>['executionContext'];
};

export type RunView = {
  id: string;
  jobId: string;
  status: 'completed' | 'failed' | 'running' | 'waiting';
  startedAt: string;
  duration: string;
  outcome: string;
};

export type RunEventView = {
  id: number;
  label: string;
  time: string;
  status: 'done' | 'active' | 'failed';
};

export type CreateJobInput = {
  name: string;
  prompt: string;
  kind: 'manual' | 'once' | 'recurring';
  runAt?: string;
  schedule?: { type: string; value?: string };
  executionContext: {
    conversationJid: string;
    threadId: string | null;
    workspaceKey: string;
    sessionId: string;
  };
};

export const jobQueryKeys = {
  all: ['jobs'] as const,
  list: () => [...jobQueryKeys.all, 'list'] as const,
  detail: (jobId: string) => [...jobQueryKeys.all, 'detail', jobId] as const,
  runs: (jobId: string) => [...jobQueryKeys.all, 'runs', jobId] as const,
  run: (runId: string) => [...jobQueryKeys.all, 'run', runId] as const,
};

export async function loadJobs(
  transport: RuntimeApiTransport,
): Promise<JobView[]> {
  const result = await transport.request({
    path: '/jobs',
    schema: jobListSchema,
  });
  return result.jobs.filter((job) => job.status !== 'deleted').map(mapJob);
}

export async function loadJob(
  transport: RuntimeApiTransport,
  jobId: string,
): Promise<JobView> {
  const result = await transport.request({
    path: `/jobs/${encodeURIComponent(jobId)}`,
    schema: jobSchema,
  });
  return mapJob(result);
}

export async function loadRuns(
  transport: RuntimeApiTransport,
  jobId: string,
): Promise<RunView[]> {
  const result = await transport.request({
    path: '/runs',
    query: { jobId },
    schema: runListSchema,
  });
  return result.runs.map(mapRun);
}

export async function loadRunDetail(
  transport: RuntimeApiTransport,
  runId: string,
) {
  const [run, events] = await Promise.all([
    transport.request({
      path: `/runs/${encodeURIComponent(runId)}`,
      schema: runSchema,
    }),
    transport.request({
      path: `/runs/${encodeURIComponent(runId)}/events`,
      schema: runEventListSchema,
    }),
  ]);
  return { run: mapRun(run), events: events.events.map(mapRunEvent) };
}

export function createJob(
  transport: RuntimeApiTransport,
  input: CreateJobInput,
) {
  return transport.request({
    path: '/jobs',
    method: 'POST',
    body: input,
    schema: mutationResponseSchema,
  });
}

export function updateJob(
  transport: RuntimeApiTransport,
  jobId: string,
  patch: Record<string, unknown>,
) {
  return transport.request({
    path: `/jobs/${encodeURIComponent(jobId)}`,
    method: 'PATCH',
    body: patch,
    schema: jobSchema,
  });
}

export function deleteJob(transport: RuntimeApiTransport, jobId: string) {
  return transport.request({
    path: `/jobs/${encodeURIComponent(jobId)}`,
    method: 'DELETE',
    schema: mutationResponseSchema,
  });
}

export function runJobAction(
  transport: RuntimeApiTransport,
  jobId: string,
  action: 'pause' | 'resume' | 'trigger',
) {
  return transport.request({
    path: `/jobs/${encodeURIComponent(jobId)}/${action}`,
    method: 'POST',
    schema: mutationResponseSchema,
  });
}

function mapJob(job: z.infer<typeof jobSchema>): JobView {
  const blocked = Boolean(job.setup && job.setup.state !== 'ready');
  const blocker = job.setup?.blockers[0];
  return {
    id: job.jobId,
    name: job.name,
    description: job.promptPreview ?? 'No prompt preview available.',
    prompt: job.fullPrompt ?? job.promptPreview ?? '',
    agent:
      job.workspaceKey ?? job.executionContext?.workspaceKey ?? 'Unavailable',
    status: blocked
      ? 'blocked'
      : job.status === 'paused'
        ? 'paused'
        : 'enabled',
    canonicalStatus: job.status,
    kind: job.kind,
    schedule: formatSchedule(job),
    nextRun: job.nextRun
      ? formatDateTime(job.nextRun)
      : job.status === 'paused'
        ? 'Paused'
        : 'Not scheduled',
    notificationRoutes: job.notificationRoutes.map(
      (route) => route.label ?? route.conversationJid,
    ),
    blocker: blocked
      ? {
          summary:
            blocker?.reason ?? job.setupLabel ?? 'Job setup is incomplete.',
          action: blocker?.nextAction ?? job.nextActionLabel ?? 'Review setup',
        }
      : undefined,
    executionContext: job.executionContext,
  };
}

function mapRun(run: z.infer<typeof runSchema>): RunView {
  const status = normalizeRunStatus(run.status);
  return {
    id: run.run_id,
    jobId: run.job_id,
    status,
    startedAt: run.started_at ? formatDateTime(run.started_at) : 'Not started',
    duration: formatDuration(run.started_at, run.completed_at),
    outcome:
      status === 'completed'
        ? 'Run completed.'
        : status === 'failed'
          ? 'Run failed. Review the safe event timeline.'
          : status === 'running'
            ? 'Run is active.'
            : 'Run is waiting to start.',
  };
}

function mapRunEvent(
  event: z.infer<typeof runEventListSchema>['events'][number],
): RunEventView {
  const failed =
    event.eventType.includes('failed') || event.eventType.includes('error');
  const active =
    event.eventType.includes('started') || event.eventType.includes('progress');
  return {
    id: event.eventId,
    label: event.eventType,
    time: formatDateTime(event.createdAt),
    status: failed ? 'failed' : active ? 'active' : 'done',
  };
}

function normalizeRunStatus(status: string): RunView['status'] {
  if (status === 'completed' || status === 'failed' || status === 'running')
    return status;
  return status.includes('fail') ? 'failed' : 'waiting';
}

function formatSchedule(job: z.infer<typeof jobSchema>): string {
  if (job.kind === 'manual' || !job.schedule) return 'Manual only';
  return (
    job.schedule.runAt ?? job.schedule.value ?? job.schedule.type ?? 'Scheduled'
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(start?: string, end?: string | null): string {
  if (!start) return 'Unavailable';
  const startMs = new Date(start).getTime();
  const endMs = end ? new Date(end).getTime() : Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
    return 'Unavailable';
  const seconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
