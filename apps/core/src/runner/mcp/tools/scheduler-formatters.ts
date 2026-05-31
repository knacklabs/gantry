import {
  jobSetupBlockerFromUnknown,
  setupActionLabel,
  setupActionLabelFromNextAction,
  setupReadinessLabel,
} from '../../../shared/job-setup-labels.js';
import {
  deliveryLabel as providerDeliveryLabel,
  ownerLabel as providerOwnerLabel,
} from '../../../channels/provider-delivery-labels.js';
import { semanticCapabilityRule } from '../../../shared/semantic-capability-ids.js';

export function schedulerJobSummary(job: unknown): string {
  const record =
    typeof job === 'object' && job !== null ? (job as Record<string, any>) : {};
  const visibility =
    typeof record.visibility === 'object' && record.visibility !== null
      ? (record.visibility as Record<string, any>)
      : {};
  const target =
    typeof visibility.target === 'object' && visibility.target !== null
      ? (visibility.target as Record<string, any>)
      : {};
  const executionContext =
    typeof visibility.executionContext === 'object' &&
    visibility.executionContext !== null
      ? (visibility.executionContext as Record<string, any>)
      : {};
  const notificationRoutes = Array.isArray(visibility.notificationRoutes)
    ? visibility.notificationRoutes
    : [];
  const recentErrors = Array.isArray(visibility.recentRunErrors)
    ? visibility.recentRunErrors.length
    : 0;
  const staleness =
    typeof visibility.staleness === 'string' ? visibility.staleness : 'none';
  const toolAccess = toolAccessRecord(visibility.toolAccess);
  const recordAccess = Array.isArray(record.access_requirements)
    ? splitRecordAccessRequirements(record.access_requirements)
    : undefined;
  const toolAccessRequirements = stringArray(
    recordAccess ? recordAccess.toolRules : visibility.toolAccessRequirements,
  );
  const capabilityRequirements = capabilityRequirementLabels(
    recordAccess
      ? recordAccess.capabilities
      : visibility.capabilityRequirements,
  );
  const requiredMcpServers = stringArray(
    recordAccess ? recordAccess.mcpServers : visibility.requiredMcpServers,
  );
  const health =
    typeof visibility.health === 'object' && visibility.health !== null
      ? (visibility.health as Record<string, any>)
      : {};
  const setup =
    typeof visibility.setup === 'object' && visibility.setup !== null
      ? (visibility.setup as Record<string, any>)
      : {};
  const recovery =
    typeof visibility.recovery === 'object' && visibility.recovery !== null
      ? (visibility.recovery as Record<string, any>)
      : {};
  const toolAccessLine = toolAccess.present
    ? `Tool access: inherited ${formatTools(toolAccess.inheritedAgentTools)}; effective ${formatTools(toolAccess.effectiveAllowedTools)}; projected ${formatTools(toolAccess.projectedRuntimeTools)}`
    : 'Tool access: missing canonical toolAccess';
  const nextAction =
    typeof health.nextAction === 'string' && health.nextAction.trim()
      ? setupActionLabelFromNextAction(health.nextAction, 'none')
      : 'none';
  const setupAction = setupActionSummary(setup);
  const primaryRoute =
    typeof notificationRoutes[0] === 'object' && notificationRoutes[0] !== null
      ? (notificationRoutes[0] as Record<string, any>)
      : {};
  const ownerLabelText = preferredOwnerLabel({
    visibility,
    conversationJid: String(
      executionContext.conversationJid ?? target.conversationJids?.[0] ?? '',
    ),
  });
  const deliveryLabelText = preferredDeliveryLabel({
    visibility,
    conversationJid: String(
      primaryRoute.conversationJid ?? executionContext.conversationJid ?? '',
    ),
    threadId: primaryRoute.threadId ?? executionContext.threadId ?? null,
  });
  const setupLabelText =
    typeof visibility.setupLabel === 'string' && visibility.setupLabel
      ? visibility.setupLabel
      : setupReadinessLabel(String(setup.state ?? 'ready'));
  const nextActionLabelText =
    typeof visibility.nextActionLabel === 'string' && visibility.nextActionLabel
      ? visibility.nextActionLabel
      : setupAction !== 'none'
        ? setupAction
        : nextAction;
  return [
    `Job: ${String(record.name ?? record.id ?? 'unknown')}`,
    `Owned by: ${ownerLabelText}`,
    `Delivers to: ${deliveryLabelText}`,
    `Setup: ${setupLabelText}`,
    `Next action: ${nextActionLabelText}`,
    `Health: ${String(health.state ?? 'unknown')} | latest ${String(health.latestRunStatus ?? 'none')} | action ${nextAction}`,
    `Recovery: ${recoverySummary(recovery)}`,
    `Target: ${String(target.agentId ?? record.workspace_key ?? 'unknown')} in ${String(target.conversationJids?.[0] ?? 'no conversation')}`,
    `Execution context: ${String(executionContext.conversationJid ?? 'unknown')} | thread ${String(executionContext.threadId ?? 'none')} | workspace ${String(executionContext.workspaceKey ?? record.workspace_key ?? 'unknown')}`,
    `Notification routes: ${notificationRoutes.length}`,
    `Kind/status: ${String(record.schedule_type ?? 'unknown')} / ${String(record.status ?? 'unknown')}`,
    `Next/last run: ${String(record.next_run ?? 'none')} / ${String(record.last_run ?? 'none')}`,
    `Staleness: ${staleness}`,
    `Access requirements: ${formatAccessRequirementSummary({
      capabilityRequirements,
      toolAccessRequirements,
      requiredMcpServers,
    })}`,
    toolAccessLine,
    `Recent run errors: ${recentErrors}`,
    '',
    'Structured JSON:',
    JSON.stringify(record, null, 2),
  ].join('\n');
}

function preferredOwnerLabel(input: {
  visibility: Record<string, any>;
  conversationJid: string;
}): string {
  const inferred = providerOwnerLabel(input.conversationJid);
  if (inferred !== 'conversation') return inferred;
  return typeof input.visibility.ownerLabel === 'string' &&
    input.visibility.ownerLabel
    ? input.visibility.ownerLabel
    : inferred;
}

function preferredDeliveryLabel(input: {
  visibility: Record<string, any>;
  conversationJid: string;
  threadId: string | null | undefined;
}): string {
  const inferred = providerDeliveryLabel(input.conversationJid, input.threadId);
  if (inferred !== 'conversation') return inferred;
  return typeof input.visibility.deliveryLabel === 'string' &&
    input.visibility.deliveryLabel
    ? input.visibility.deliveryLabel
    : inferred;
}

function setupActionSummary(setup: Record<string, any>): string {
  const blockers = Array.isArray(setup.blockers) ? setup.blockers : [];
  const blocker = jobSetupBlockerFromUnknown(blockers[0]);
  if (blocker) return setupActionLabel(blocker);
  return setupActionLabelFromNextAction(setup.nextAction, 'none');
}

export function schedulerJobsSummary(jobs: unknown[]): string {
  const lines = jobs.map((job) => {
    const record =
      typeof job === 'object' && job !== null
        ? (job as Record<string, any>)
        : {};
    const visibility =
      typeof record.visibility === 'object' && record.visibility !== null
        ? (record.visibility as Record<string, any>)
        : {};
    const target =
      typeof visibility.target === 'object' && visibility.target !== null
        ? (visibility.target as Record<string, any>)
        : {};
    const executionContext =
      typeof visibility.executionContext === 'object' &&
      visibility.executionContext !== null
        ? (visibility.executionContext as Record<string, any>)
        : {};
    const health =
      typeof visibility.health === 'object' && visibility.health !== null
        ? (visibility.health as Record<string, any>)
        : {};
    const setup =
      typeof visibility.setup === 'object' && visibility.setup !== null
        ? (visibility.setup as Record<string, any>)
        : {};
    const setupAction = setupActionSummary(setup);
    const nextAction =
      typeof visibility.nextActionLabel === 'string' &&
      visibility.nextActionLabel
        ? visibility.nextActionLabel
        : setupAction !== 'none'
          ? setupAction
          : setupActionLabelFromNextAction(health.nextAction, 'none');
    const setupLabel =
      typeof visibility.setupLabel === 'string' && visibility.setupLabel
        ? visibility.setupLabel
        : setupReadinessLabel(String(setup.state ?? 'ready'));
    const workspaceKey = String(
      executionContext.workspaceKey ?? record.workspace_key ?? 'unknown',
    );
    const agent = String(target.agentId ?? record.agent_id ?? 'unknown');
    return `- ${String(record.id ?? 'unknown')} | ${String(record.name ?? '')} | ${setupLabel} | Workspace: ${workspaceKey} | Agent: ${agent} | Next: ${nextAction}`;
  });
  return [
    `Scheduler jobs (${jobs.length})`,
    ...lines,
    '',
    'Structured JSON:',
    JSON.stringify(jobs, null, 2),
  ].join('\n');
}

function recoverySummary(recovery: Record<string, any>): string {
  const state = String(recovery.state ?? 'none');
  if (state === 'none') return 'none';
  const target =
    recovery.requirementType && recovery.requirementId
      ? ` ${String(recovery.requirementType)}:${String(recovery.requirementId)}`
      : '';
  const nextAction =
    typeof recovery.nextAction === 'string' && recovery.nextAction.trim()
      ? ` | action ${setupActionLabelFromNextAction(recovery.nextAction, 'review setup')}`
      : '';
  return `${state}${recovery.kind ? ` (${String(recovery.kind)})` : ''}${target} attempts=${String(recovery.attempts ?? 0)}${nextAction}`;
}

export function schedulerEventsSummary(events: unknown[]): string {
  const lines = events.map((event) => {
    const record =
      typeof event === 'object' && event !== null
        ? (event as Record<string, any>)
        : {};
    const payload = parsePayload(record.payload);
    const phase = typeof payload.phase === 'string' ? payload.phase : '';
    const tool = typeof payload.tool === 'string' ? payload.tool : '';
    const diagnostic = [phase, tool].filter(Boolean).join(' ');
    const browserCount =
      typeof payload.browser_activity_count === 'number'
        ? ` browser_activity=${payload.browser_activity_count}`
        : '';
    const error =
      typeof payload.error === 'string' && payload.error.trim()
        ? ` error=${payload.error.slice(0, 160)}`
        : '';
    return `- ${String(record.id ?? 'unknown')} | ${String(record.event_type ?? '')} | run ${String(record.run_id ?? 'none')} | ${diagnostic || 'event'}${browserCount}${error}`;
  });
  return [
    `Scheduler events (${events.length})`,
    ...lines,
    '',
    'Structured JSON:',
    JSON.stringify(events, null, 2),
  ].join('\n');
}

function toolAccessRecord(value: unknown): {
  present: boolean;
  inheritedAgentTools: string[];
  effectiveAllowedTools: string[];
  projectedRuntimeTools: string[];
} {
  const present = typeof value === 'object' && value !== null;
  const record =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    present,
    inheritedAgentTools: stringArray(record.inheritedAgentTools),
    effectiveAllowedTools: stringArray(record.effectiveAllowedTools),
    projectedRuntimeTools: stringArray(record.projectedRuntimeTools),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function capabilityRequirementLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item !== 'object' || item === null) return undefined;
      const record = item as Record<string, unknown>;
      const capabilityId =
        typeof record.capabilityId === 'string'
          ? record.capabilityId
          : undefined;
      if (!capabilityId) return undefined;
      const implementation =
        typeof record.implementation === 'object' &&
        record.implementation !== null
          ? (record.implementation as Record<string, unknown>)
          : undefined;
      const implementationName =
        typeof implementation?.name === 'string' ? implementation.name : '';
      return implementationName
        ? `${capabilityId} via ${implementationName}`
        : capabilityId;
    })
    .filter((item): item is string => Boolean(item));
}

function splitRecordAccessRequirements(value: readonly unknown[]): {
  toolRules: string[];
  capabilities: Array<Record<string, unknown>>;
  mcpServers: string[];
} {
  const toolRules: string[] = [];
  const capabilities: Array<Record<string, unknown>> = [];
  const mcpServers: string[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const target = (item as Record<string, unknown>).target;
    if (typeof target !== 'object' || target === null) continue;
    const record = target as Record<string, unknown>;
    if (record.kind === 'tool_rule' && typeof record.rule === 'string') {
      toolRules.push(record.rule);
    } else if (
      record.kind === 'capability' &&
      typeof record.capabilityId === 'string'
    ) {
      // Mirror the runtime split: capability targets also derive a
      // capability:<id> tool rule.
      toolRules.push(semanticCapabilityRule(String(record.capabilityId)));
      capabilities.push({
        capabilityId: record.capabilityId,
        implementation: record.implementation,
      });
    } else if (
      record.kind === 'mcp_server' &&
      typeof record.server === 'string'
    ) {
      mcpServers.push(record.server);
    }
  }
  return { toolRules, capabilities, mcpServers };
}

function formatTools(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function formatAccessRequirementSummary(input: {
  capabilityRequirements: readonly string[];
  toolAccessRequirements: readonly string[];
  requiredMcpServers: readonly string[];
}): string {
  const parts = [
    input.capabilityRequirements.length
      ? `capabilities ${formatTools(input.capabilityRequirements)}`
      : undefined,
    input.toolAccessRequirements.length
      ? `tools ${formatTools(input.toolAccessRequirements)}`
      : undefined,
    input.requiredMcpServers.length
      ? `MCP servers ${formatTools(input.requiredMcpServers)}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('; ') : '(none)';
}

function parsePayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
