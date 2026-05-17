import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';
import {
  compactToolList,
  formatJobToolAccess,
  type JobToolAccessView,
} from '../shared/tool-access-view.js';
import {
  jobSetupBlockerFromUnknown,
  setupActionLabel,
  setupActionLabelFromNextAction,
} from '../shared/job-setup-labels.js';

interface JobRecord {
  jobId: string;
  name: string;
  kind: string;
  status: string;
  groupScope: string;
  threadId?: string | null;
  executionContext?: {
    conversationJid?: string;
    groupScope?: string;
    threadId?: string | null;
    sessionId?: string | null;
  };
  nextRun: string | null;
  lastRun: string | null;
  modelAlias: string | null;
  health?: {
    state?: string;
    nextAction?: string | null;
    latestRunStatus?: string | null;
  };
  setup?: {
    state?: string;
    nextAction?: string | null;
    blockers?: Array<{
      requirementType?: string;
      requirementId?: string;
      message?: string;
      nextAction?: string;
    }>;
  };
  prompt?: string;
  promptPreview?: string;
  schedule?: unknown;
  toolAccess: JobToolAccessView;
  recentRunErrors?: Array<{
    runId: string;
    status: string;
    errorSummary: string;
    endedAt: string | null;
  }>;
  requiredTools?: string[];
  requiredMcpServers?: string[];
}

interface JobEventRecord {
  id: number;
  job_id: string;
  run_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
}

export async function runJobsCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [action, maybeJobId, ...rest] = args;
  if (action === 'list') return listJobs(runtimeHome, [maybeJobId, ...rest]);
  if (action === 'show' && maybeJobId) return showJob(runtimeHome, maybeJobId);
  if (action === 'resume' && maybeJobId) {
    return resumeJob(runtimeHome, maybeJobId);
  }
  if (action === 'events' && maybeJobId) {
    return listJobEvents(runtimeHome, maybeJobId, rest);
  }
  p.log.error(
    'Usage: myclaw jobs list|show <job_id>|resume <job_id>|events <job_id> [--run <run_id>]',
  );
  return 1;
}

async function listJobs(runtimeHome: string, args: string[]): Promise<number> {
  const params = new URLSearchParams();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const next = args[index + 1];
    if (arg === '--agent' && next) {
      params.set('agentId', next);
      index += 1;
    } else if (arg === '--group' && next) {
      params.set('groupScope', next);
      index += 1;
    } else if (arg === '--conversation' && next) {
      params.set('conversationJid', next);
      index += 1;
    } else if (arg === '--kind' && next) {
      params.set('kind', next);
      index += 1;
    } else if (arg === '--status' && next) {
      params.append('status', next);
      index += 1;
    } else if (arg === '--limit' && next) {
      params.set('limit', next);
      index += 1;
    }
  }
  const response = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs${params.toString() ? `?${params}` : ''}`,
  })) as { jobs?: JobRecord[] };
  const jobs = response.jobs ?? [];
  if (jobs.length === 0) {
    p.note('No jobs found.', 'Jobs');
    return 0;
  }
  p.note(formatJobTable(jobs), 'Jobs');
  return 0;
}

async function showJob(runtimeHome: string, jobId: string): Promise<number> {
  const job = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs/${encodeURIComponent(jobId)}`,
  })) as JobRecord;
  p.note(formatJobDetail(job), `Job ${jobId}`);
  return 0;
}

async function resumeJob(runtimeHome: string, jobId: string): Promise<number> {
  const response = (await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/jobs/${encodeURIComponent(jobId)}/resume`,
  })) as { resumed?: boolean; setup?: JobRecord['setup'] };
  const setup = response.setup;
  const lines = [
    `Resumed: ${response.resumed ? 'yes' : 'no'}`,
    `Setup: ${setup?.state ?? 'ready'}`,
  ];
  if (setup?.nextAction) {
    lines.push(`Next Action: ${formatJobNextAction(setup)}`);
  }
  if (setup?.blockers?.length) {
    lines.push(
      'Setup Blockers:',
      ...setup.blockers.map(
        (blocker) =>
          `  ${blocker.requirementType ?? 'requirement'}:${blocker.requirementId ?? 'unknown'} ${blocker.message ?? ''}`,
      ),
    );
  }
  p.note(lines.join('\n'), `Job ${jobId}`);
  return 0;
}

async function listJobEvents(
  runtimeHome: string,
  jobId: string,
  args: string[],
): Promise<number> {
  const params = new URLSearchParams();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--run' && next) {
      params.set('run', next);
      index += 1;
    } else if (arg === '--event-type' && next) {
      params.set('eventType', next);
      index += 1;
    } else if (arg === '--since-id' && next) {
      params.set('sinceId', next);
      index += 1;
    } else if (arg === '--limit' && next) {
      params.set('limit', next);
      index += 1;
    }
  }
  const response = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs/${encodeURIComponent(jobId)}/events${
      params.toString() ? `?${params}` : ''
    }`,
  })) as { events?: JobEventRecord[] };
  const events = response.events ?? [];
  if (events.length === 0) {
    p.note('No job events found.', `Job ${jobId} Events`);
    return 0;
  }
  p.note(formatJobEvents(events), `Job ${jobId} Events`);
  return 0;
}

function formatJobTable(jobs: JobRecord[]): string {
  const rows = jobs.map((job) => [
    job.jobId,
    job.kind,
    job.setup?.state && job.setup.state !== 'ready'
      ? job.setup.state
      : (job.health?.state ?? job.status),
    job.groupScope,
    jobThreadId(job) ?? '',
    job.nextRun ?? '',
    compactToolList([
      ...(job.requiredTools ?? []),
      ...(job.requiredMcpServers ?? []).map((server) => `mcp:${server}`),
    ]),
    compactToolList(job.toolAccess.effectiveAllowedTools),
    job.name,
  ]);
  const headers = [
    'ID',
    'Kind',
    'Status',
    'Group',
    'Thread',
    'Next run',
    'Required',
    'Tools',
    'Name',
  ];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function formatJobDetail(job: JobRecord): string {
  const lines = [
    `ID: ${job.jobId}`,
    `Name: ${job.name}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Health: ${job.health?.state ?? job.status}`,
    `Setup: ${job.setup?.state ?? 'ready'}`,
    `Group: ${job.groupScope}`,
    `Thread: ${jobThreadId(job) ?? '(none)'}`,
    `Next Run: ${job.nextRun ?? '(none)'}`,
    `Last Run: ${job.lastRun ?? '(none)'}`,
    `Model: ${job.modelAlias ?? '(default)'}`,
    `Required Tools: ${formatRequiredTools(job.requiredTools)}`,
    `Required MCP Servers: ${formatRequiredTools(job.requiredMcpServers)}`,
    '',
    formatJobToolAccess(job.toolAccess),
  ];
  if (job.promptPreview || job.prompt) {
    lines.push('', `Prompt: ${job.promptPreview ?? job.prompt}`);
  }
  const nextAction = job.setup?.nextAction ?? job.health?.nextAction;
  if (nextAction) {
    lines.push(
      '',
      `Next Action: ${formatJobNextAction(job.setup, nextAction)}`,
    );
  }
  if (job.setup?.blockers?.length) {
    lines.push(
      '',
      'Setup Blockers:',
      ...job.setup.blockers.map(
        (blocker) =>
          `  ${blocker.requirementType ?? 'requirement'}:${blocker.requirementId ?? 'unknown'} ${blocker.message ?? ''}`,
      ),
    );
  }
  if (job.recentRunErrors?.length) {
    lines.push(
      '',
      'Recent Run Errors:',
      ...job.recentRunErrors.map(
        (error) => `  ${error.runId} ${error.status}: ${error.errorSummary}`,
      ),
    );
  }
  return lines.join('\n');
}

function formatJobNextAction(
  setup?: JobRecord['setup'],
  fallbackNextAction?: unknown,
): string {
  const blocker = jobSetupBlockerFromUnknown(setup?.blockers?.[0]);
  if (blocker) return setupActionLabel(blocker);
  return setupActionLabelFromNextAction(
    setup?.nextAction ?? fallbackNextAction,
    'Fix setup, then resume the job.',
  );
}

function formatJobEvents(events: JobEventRecord[]): string {
  const rows = events.map((event) => [
    String(event.id),
    event.created_at,
    event.run_id ?? '',
    event.event_type,
    formatEventPayload(event.payload),
  ]);
  const headers = ['ID', 'Created', 'Run', 'Type', 'Payload'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function jobThreadId(job: JobRecord): string | null {
  return job.executionContext?.threadId ?? job.threadId ?? null;
}

function formatEventPayload(payload: string | null): string {
  if (!payload) return '';
  const singleLine = payload.replace(/\s+/g, ' ').trim();
  return singleLine.length > 160
    ? `${singleLine.slice(0, 157)}...`
    : singleLine;
}

function formatRequiredTools(requiredTools: string[] | undefined): string {
  return requiredTools && requiredTools.length > 0
    ? requiredTools.join(', ')
    : '(none)';
}
