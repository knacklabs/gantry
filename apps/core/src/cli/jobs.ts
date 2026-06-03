import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';
import {
  formatJobToolAccess,
  type JobToolAccessView,
} from '../shared/tool-access-view.js';
import {
  jobSetupBlockerFromUnknown,
  setupActionLabel,
  setupActionLabelFromNextAction,
  setupReadinessLabel,
} from '../shared/job-setup-labels.js';
import { agentIdForJobWorkspaceKey } from '../application/jobs/job-tool-policy.js';

interface JobRecord {
  jobId: string;
  name: string;
  kind: string;
  status: string;
  workspaceKey: string;
  threadId?: string | null;
  executionContext?: {
    conversationJid?: string;
    workspaceKey?: string;
    threadId?: string | null;
    sessionId?: string | null;
  };
  notificationRoutes?: Array<{
    conversationJid?: string;
    threadId?: string | null;
    label?: string;
  }>;
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
  recovery?: {
    state?: string;
    kind?: string | null;
    attempts?: number;
    requirementType?: string | null;
    requirementId?: string | null;
    nextAction?: string | null;
    lastError?: string | null;
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
  accessRequirements?: Array<{
    target:
      | { kind: 'tool_rule'; rule: string }
      | {
          kind: 'capability';
          capabilityId: string;
          implementation?: { kind?: string; name?: string };
        }
      | { kind: 'mcp_server'; server: string };
    reason?: string;
  }>;
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
  if (action === 'trigger' && maybeJobId) {
    return triggerJob(runtimeHome, maybeJobId);
  }
  if (action === 'set-route' && maybeJobId) {
    return setJobRoute(runtimeHome, maybeJobId, rest);
  }
  if (action === 'events' && maybeJobId) {
    return listJobEvents(runtimeHome, maybeJobId, rest);
  }
  p.log.error(
    'Usage: gantry jobs list|show <job_id>|resume <job_id>|trigger <job_id>|set-route <job_id> --conversation <jid> --thread <id|null>|events <job_id> [--run <run_id>] [--full|--json]',
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
    } else if (arg === '--workspace' && next) {
      params.set('workspaceKey', next);
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

async function triggerJob(runtimeHome: string, jobId: string): Promise<number> {
  const response = (await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/jobs/${encodeURIComponent(jobId)}/trigger`,
  })) as { triggerId?: string };
  p.note(
    [`Trigger ID: ${response.triggerId ?? '(unknown)'}`].join('\n'),
    `Job ${jobId} queued`,
  );
  return 0;
}

async function setJobRoute(
  runtimeHome: string,
  jobId: string,
  args: string[],
): Promise<number> {
  const parsed = parseSetRouteArgs(args);
  if (!parsed) {
    p.log.error(
      'Usage: gantry jobs set-route <job_id> --conversation <jid> --thread <id|null> [--label <label>] [--workspace <workspace_key>]',
    );
    return 1;
  }
  const current = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs/${encodeURIComponent(jobId)}`,
  })) as JobRecord;
  const sessionId = current.executionContext?.sessionId ?? undefined;
  const body = {
    ...(sessionId
      ? {
          executionContext: {
            conversationJid: parsed.conversationJid,
            threadId: parsed.threadId,
            workspaceKey:
              parsed.workspaceKey ??
              current.executionContext?.workspaceKey ??
              current.workspaceKey,
            sessionId,
          },
        }
      : {}),
    notificationRoutes: [
      {
        conversationJid: parsed.conversationJid,
        threadId: parsed.threadId,
        label: parsed.label,
      },
    ],
  };
  const updated = (await controlApiRequest(runtimeHome, {
    method: 'PATCH',
    path: `/v1/jobs/${encodeURIComponent(jobId)}`,
    body,
  })) as JobRecord;
  p.note(formatJobRoutes(updated), `Job ${jobId} route updated`);
  return 0;
}

async function listJobEvents(
  runtimeHome: string,
  jobId: string,
  args: string[],
): Promise<number> {
  const params = new URLSearchParams();
  let full = false;
  let json = false;
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
    } else if (arg === '--full') {
      full = true;
    } else if (arg === '--json') {
      json = true;
    }
  }
  const response = (await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/jobs/${encodeURIComponent(jobId)}/events${
      params.toString() ? `?${params}` : ''
    }`,
  })) as { events?: JobEventRecord[] };
  const events = response.events ?? [];
  if (json) {
    console.log(JSON.stringify({ events }, null, 2));
    return 0;
  }
  if (events.length === 0) {
    p.note('No job events found.', `Job ${jobId} Events`);
    return 0;
  }
  p.note(formatJobEvents(events, { full }), `Job ${jobId} Events`);
  return 0;
}

function formatJobTable(jobs: JobRecord[]): string {
  return jobs
    .map((job) =>
      [
        job.jobId,
        job.name,
        setupReadinessLabel(job.setup?.state),
        `Workspace: ${job.workspaceKey}`,
        `Agent: ${jobAgentLabel(job)}`,
        `Next: ${jobNextActionLabel(job)}`,
      ].join(' | '),
    )
    .join('\n');
}

function jobAgentLabel(job: JobRecord): string {
  return agentIdForJobWorkspaceKey(job.workspaceKey);
}

function jobConversationLabel(job: JobRecord): string {
  const route = job.notificationRoutes?.find(
    (entry) => entry.conversationJid || entry.label,
  );
  if (route?.label) return route.label;
  const conversationJid =
    job.executionContext?.conversationJid ?? route?.conversationJid;
  return conversationJid ?? 'none';
}

function jobAccessRequirementsLabel(job: JobRecord): string {
  const requirements = formatAccessRequirements(job.accessRequirements);
  return requirements.length > 0 ? requirements.join(', ') : 'none';
}

function jobNextActionLabel(job: JobRecord): string {
  const nextAction =
    job.setup?.nextAction ?? job.recovery?.nextAction ?? job.health?.nextAction;
  if (!job.setup?.blockers?.length && !nextAction) return 'none';
  return formatJobNextAction(job.setup, nextAction);
}

function formatJobDetail(job: JobRecord): string {
  const lines = [
    `ID: ${job.jobId}`,
    `Name: ${job.name}`,
    `Kind: ${job.kind}`,
    `Status: ${job.status}`,
    `Health: ${job.health?.state ?? job.status}`,
    `Recovery: ${formatJobRecovery(job.recovery)}`,
    `Workspace: ${job.workspaceKey}`,
    `Agent: ${jobAgentLabel(job)}`,
    `Conversation: ${jobConversationLabel(job)}`,
    `Thread: ${jobThreadId(job) ?? 'none'}`,
    `Setup: ${setupReadinessLabel(job.setup?.state)}`,
    `Next action: ${jobNextActionLabel(job)}`,
    `Access requirements: ${jobAccessRequirementsLabel(job)}`,
    formatJobToolAccess(job.toolAccess),
    `Notifications: ${formatJobRoutes(job)}`,
    `Next Run: ${job.nextRun ?? '(none)'}`,
    `Last Run: ${job.lastRun ?? '(none)'}`,
    `Model: ${job.modelAlias ?? '(default)'}`,
  ];
  if (job.promptPreview || job.prompt) {
    lines.push('', `Prompt: ${job.promptPreview ?? job.prompt}`);
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
  if (job.recovery?.lastError) {
    lines.push('', `Recovery Error: ${job.recovery.lastError}`);
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

function formatJobRecovery(recovery?: JobRecord['recovery']): string {
  if (!recovery || !recovery.state || recovery.state === 'none') {
    return 'none';
  }
  const target =
    recovery.requirementType && recovery.requirementId
      ? ` ${recovery.requirementType}:${recovery.requirementId}`
      : '';
  return `${recovery.state}${recovery.kind ? ` (${recovery.kind})` : ''}${target} attempts=${recovery.attempts ?? 0}`;
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

function formatJobEvents(
  events: JobEventRecord[],
  options: { full?: boolean } = {},
): string {
  const rows = events.map((event) => [
    String(event.id),
    event.created_at,
    event.run_id ?? '',
    event.event_type,
    formatEventPayload(event.payload, options),
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

function formatJobRoutes(job: JobRecord): string {
  const routes = job.notificationRoutes ?? [];
  if (routes.length === 0) return '(none)';
  return routes
    .map((route) => {
      const label = route.label ? `${route.label}:` : '';
      return `${label}${route.conversationJid ?? '(unknown)'}${route.threadId ? `/${route.threadId}` : ''}`;
    })
    .join(', ');
}

function parseSetRouteArgs(args: string[]): {
  conversationJid: string;
  threadId: string | null;
  label: string;
  workspaceKey?: string;
} | null {
  let conversationJid = '';
  let threadId: string | null | undefined;
  let label = 'primary';
  let workspaceKey: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === '--conversation' && next) {
      conversationJid = next.trim();
      index += 1;
    } else if (arg === '--thread' && next) {
      const raw = next.trim();
      threadId = raw === 'null' || raw === 'none' || raw === '-' ? null : raw;
      index += 1;
    } else if (arg === '--label' && next) {
      label = next.trim() || label;
      index += 1;
    } else if (arg === '--workspace' && next) {
      workspaceKey = next.trim() || undefined;
      index += 1;
    }
  }
  if (!conversationJid || threadId === undefined) return null;
  return { conversationJid, threadId, label, workspaceKey };
}

function formatEventPayload(
  payload: string | null,
  options: { full?: boolean } = {},
): string {
  if (!payload) return '';
  const singleLine = payload.replace(/\s+/g, ' ').trim();
  if (options.full) return singleLine;
  return singleLine.length > 160
    ? `${singleLine.slice(0, 157)}...`
    : singleLine;
}

function formatAccessRequirements(
  accessRequirements: JobRecord['accessRequirements'],
): string[] {
  return (accessRequirements ?? [])
    .map((requirement) => {
      const target = requirement.target;
      if (target.kind === 'tool_rule') return target.rule;
      if (target.kind === 'mcp_server') return `mcp:${target.server}`;
      const capabilityId = target.capabilityId?.trim();
      if (!capabilityId) return undefined;
      const implementationLabel =
        target.implementation?.name || target.implementation?.kind;
      return implementationLabel
        ? `${capabilityId} via ${implementationLabel}`
        : capabilityId;
    })
    .filter((item): item is string => Boolean(item));
}
