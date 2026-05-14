import { createHash } from 'crypto';

export interface SchedulerJobPlanInput {
  jobId?: string | null;
  name: string;
  prompt: string;
  modelAlias?: string | null;
  modelProfileId?: string | null;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  executionContext?: {
    conversationJid: string;
    threadId: string | null;
    groupScope: string;
    sessionId?: string | null;
  };
  notificationRoutes?: Array<{
    conversationJid: string;
    threadId: string | null;
    label: string;
  }>;
  requiredTools?: string[];
  requiredMcpServers?: string[];
  silent?: boolean;
  cleanupAfterMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  maxConsecutiveFailures?: number;
  createdBy?: 'agent' | 'human';
}

export function schedulerJobConfirmationToken(
  input: SchedulerJobPlanInput,
): string {
  return createHash('sha256')
    .update(stableStringify(normalizePlanInput(input)))
    .digest('hex')
    .slice(0, 24);
}

export function formatSchedulerJobPlan(
  input: SchedulerJobPlanInput & {
    confirmationToken?: string;
    modelDescription?: string;
    runtimeDescription?: string;
  },
): string {
  const token = input.confirmationToken ?? schedulerJobConfirmationToken(input);
  const model =
    input.modelDescription ??
    (input.modelAlias
      ? `explicit alias ${input.modelAlias}`
      : input.modelProfileId
        ? `profile ${input.modelProfileId}`
        : 'job default for this schedule type');
  const routeText =
    input.notificationRoutes && input.notificationRoutes.length > 0
      ? input.notificationRoutes
          .map(
            (route) =>
              `${route.label}:${route.conversationJid}${route.threadId ? `#${route.threadId}` : ''}`,
          )
          .join(', ')
      : 'no notification routes';
  const runtime =
    input.runtimeDescription ??
    `execution ${formatExecutionContext(input.executionContext)}; notifications ${routeText}; background`;
  const requiredTools =
    input.requiredTools && input.requiredTools.length > 0
      ? input.requiredTools.join(', ')
      : 'none';
  const requiredMcpServers =
    input.requiredMcpServers && input.requiredMcpServers.length > 0
      ? input.requiredMcpServers.join(', ')
      : 'none';
  return [
    'Scheduler job plan. Review before confirming.',
    `- Schedule: ${input.scheduleType} ${input.scheduleValue || '(empty)'}`,
    `- Model: ${model}`,
    `- Required tools: ${requiredTools}`,
    `- Required MCP servers: ${requiredMcpServers}`,
    '- Tool access: inherited from the target agent capability selection; required tools are assertions only and missing tools will pause the job for permission.',
    '- Network: governed by the same tool permission and sandbox policy as live runs; no standalone scheduler network grant is created.',
    '- Memory: uses the target agent runtime memory settings; no memory schema or store changes are made by this plan.',
    `- Runtime: ${runtime}`,
    `- Confirmation token: ${token}`,
    'Re-run scheduler_upsert_job with confirm=true and confirmation_token set to this token to create or update the job.',
  ].join('\n');
}

function formatExecutionContext(
  context: SchedulerJobPlanInput['executionContext'],
): string {
  if (!context) return 'current conversation';
  return `${context.conversationJid}${context.threadId ? `#${context.threadId}` : ''} (${context.groupScope})`;
}

function normalizePlanInput(
  input: SchedulerJobPlanInput,
): SchedulerJobPlanInput {
  return {
    jobId: input.jobId ?? null,
    name: input.name,
    prompt: input.prompt,
    modelAlias: input.modelAlias ?? null,
    modelProfileId: input.modelProfileId ?? null,
    scheduleType: input.scheduleType,
    scheduleValue: input.scheduleValue,
    executionContext: input.executionContext,
    notificationRoutes: input.notificationRoutes ?? [],
    requiredTools: input.requiredTools ?? [],
    requiredMcpServers: input.requiredMcpServers ?? [],
    silent: input.silent ?? false,
    cleanupAfterMs: input.cleanupAfterMs,
    timeoutMs: input.timeoutMs,
    maxRetries: input.maxRetries,
    retryBackoffMs: input.retryBackoffMs,
    maxConsecutiveFailures: input.maxConsecutiveFailures,
    createdBy: input.createdBy ?? 'agent',
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
