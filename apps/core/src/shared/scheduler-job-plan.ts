import { createHash } from 'crypto';

export interface SchedulerJobAccessRequirementImplementation {
  kind: 'configured_access' | 'local_cli' | 'mcp_server' | 'builtin_tool';
  name?: string;
  executablePath?: string;
  executableVersion?: string;
  executableHash?: string;
  commandTemplate?: string;
  authPreflight?: string;
  protectedPaths?: string[];
  networkHosts?: string[];
}

export type SchedulerJobAccessRequirementTarget =
  | { kind: 'tool_rule'; rule: string }
  | {
      kind: 'capability';
      capabilityId: string;
      implementation?: SchedulerJobAccessRequirementImplementation;
    }
  | { kind: 'mcp_server'; server: string };

export interface SchedulerJobAccessRequirement {
  target: SchedulerJobAccessRequirementTarget;
  reason?: string;
}

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
    workspaceKey: string;
    sessionId?: string | null;
  };
  notificationRoutes?: Array<{
    conversationJid: string;
    threadId: string | null;
    label: string;
  }>;
  accessRequirements?: SchedulerJobAccessRequirement[];
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
  const requirements = input.accessRequirements ?? [];
  const toolRules = requirements
    .map((req) => (req.target.kind === 'tool_rule' ? req.target.rule : null))
    .filter((rule): rule is string => Boolean(rule));
  const capabilities = requirements.filter(
    (req) => req.target.kind === 'capability',
  );
  const mcpServers = requirements
    .map((req) => (req.target.kind === 'mcp_server' ? req.target.server : null))
    .filter((server): server is string => Boolean(server));
  const toolAccessRequirements =
    toolRules.length > 0 ? `tools ${toolRules.join(', ')}` : undefined;
  const requiredCapabilities =
    capabilities.length > 0
      ? `capabilities ${capabilities.map(formatCapabilityRequirement).join(', ')}`
      : undefined;
  const requiredMcpServers =
    mcpServers.length > 0 ? `MCP servers ${mcpServers.join(', ')}` : undefined;
  const accessRequirements = [
    requiredCapabilities,
    toolAccessRequirements,
    requiredMcpServers,
  ]
    .filter((item): item is string => Boolean(item))
    .join('; ');
  return [
    'Scheduler job plan. Review before confirming.',
    `- Schedule: ${input.scheduleType} ${input.scheduleValue || '(empty)'}`,
    `- Model: ${model}`,
    `- Access requirements: ${accessRequirements || 'none'}`,
    '- Access: inherited from the target agent capability selection; use capability:<id> for reviewed semantic access, and reserve scoped RunCommand(...) for one-off exact command preflights.',
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
  return `${context.conversationJid}${context.threadId ? `#${context.threadId}` : ''} (${context.workspaceKey})`;
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
    accessRequirements: input.accessRequirements ?? [],
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
  requirement: SchedulerJobAccessRequirement,
): string {
  if (requirement.target.kind !== 'capability') return '';
  const capability = requirement.target.capabilityId
    .split('.')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  const name = requirement.target.implementation?.name?.trim();
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
