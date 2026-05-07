import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';
import {
  compactToolList,
  formatJobToolAccess,
  type JobToolAccessView,
} from '../shared/tool-access-view.js';

interface JobRecord {
  jobId: string;
  name: string;
  kind: string;
  status: string;
  groupScope: string;
  threadId: string | null;
  nextRun: string | null;
  lastRun: string | null;
  modelAlias: string | null;
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
}

export async function runJobsCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [action, maybeJobId, ...rest] = args;
  if (action === 'list') return listJobs(runtimeHome, [maybeJobId, ...rest]);
  if (action === 'show' && maybeJobId) return showJob(runtimeHome, maybeJobId);
  p.log.error('Usage: myclaw jobs list|show <job_id>');
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

function formatJobTable(jobs: JobRecord[]): string {
  const rows = jobs.map((job) => [
    job.jobId,
    job.kind,
    job.status,
    job.groupScope,
    job.threadId ?? '',
    job.nextRun ?? '',
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
    `Group: ${job.groupScope}`,
    `Thread: ${job.threadId ?? '(none)'}`,
    `Next Run: ${job.nextRun ?? '(none)'}`,
    `Last Run: ${job.lastRun ?? '(none)'}`,
    `Model: ${job.modelAlias ?? '(default)'}`,
    '',
    formatJobToolAccess(job.toolAccess),
  ];
  if (job.promptPreview || job.prompt) {
    lines.push('', `Prompt: ${job.promptPreview ?? job.prompt}`);
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
