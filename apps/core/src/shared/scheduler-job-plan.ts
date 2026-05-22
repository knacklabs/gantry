import { createHash } from 'crypto';
import { getBuiltinSemanticCapability } from './semantic-capabilities.js';

export interface SchedulerJobPlanInput {
  jobId?: string | null;
  name: string;
  prompt: string;
  modelAlias?: string | null;
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
  capabilityRequirements?: Array<{
    capabilityId: string;
    reason: string;
    implementation?: {
      kind: 'configured_access' | 'local_cli' | 'mcp_server' | 'builtin_tool';
      name?: string;
      executablePath?: string;
      commandTemplate?: string;
      authPreflight?: string;
      protectedPaths?: string[];
    };
  }>;
  toolAccessRequirements?: string[];
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
  const toolAccessRequirements =
    input.toolAccessRequirements && input.toolAccessRequirements.length > 0
      ? input.toolAccessRequirements.join(', ')
      : 'none';
  const requiredCapabilities =
    input.capabilityRequirements && input.capabilityRequirements.length > 0
      ? input.capabilityRequirements.map(formatCapabilityRequirement).join(', ')
      : 'none';
  const requiredMcpServers =
    input.requiredMcpServers && input.requiredMcpServers.length > 0
      ? input.requiredMcpServers.join(', ')
      : 'none';
  return [
    'Scheduler job plan. Review before confirming.',
    `- Schedule: ${input.scheduleType} ${input.scheduleValue || '(empty)'}`,
    `- Model: ${model}`,
    `- Required capabilities: ${requiredCapabilities}`,
    `- Tool access requirements: ${toolAccessRequirements}`,
    `- Required MCP servers: ${requiredMcpServers}`,
    '- Tool access: inherited from the target agent capability selection; use capability:<id> for semantic access such as gog.sheets.get, and reserve scoped RunCommand(...) for one-off exact command preflights.',
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
    scheduleType: input.scheduleType,
    scheduleValue: input.scheduleValue,
    executionContext: input.executionContext,
    notificationRoutes: input.notificationRoutes ?? [],
    capabilityRequirements: input.capabilityRequirements ?? [],
    toolAccessRequirements: input.toolAccessRequirements ?? [],
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

function formatCapabilityRequirement(
  requirement: NonNullable<
    SchedulerJobPlanInput['capabilityRequirements']
  >[number],
): string {
  const capability =
    getBuiltinSemanticCapability(requirement.capabilityId)?.displayName ??
    requirement.capabilityId
      .split('.')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  const name = requirement.implementation?.name?.trim();
  return name ? `${capability} using ${name}` : capability;
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
