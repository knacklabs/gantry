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
import {
  parseSemanticCapabilityRule,
  semanticCapabilityRule,
} from '../../../shared/semantic-capability-ids.js';
import { formatDurableAccessRulesForUser } from '../../../shared/durable-access-policy.js';
import { redactSensitiveText } from '../../../shared/sensitive-material.js';

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
  const prompt = promptSummary(record, visibility);
  // Surface a missing-canonical-toolAccess diagnostic, but never dump the raw
  // inherited/effective/projected tool-id lists (those leak internal tool ids).
  const toolAccessMissing = !(
    typeof visibility.toolAccess === 'object' && visibility.toolAccess !== null
  );
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
    ...(prompt ? [`Prompt: ${prompt}`] : []),
    `Notification routes: ${notificationRoutes.length}`,
    `Kind/status: ${String(record.schedule_type ?? 'unknown')} / ${String(record.status ?? 'unknown')}`,
    `Next/last run: ${String(record.next_run ?? 'none')} / ${String(record.last_run ?? 'none')}`,
    `Staleness: ${staleness}`,
    `Access requirements: ${formatAccessRequirementSummary({
      capabilityRequirements,
      toolAccessRequirements,
      requiredMcpServers,
    })}`,
    ...(toolAccessMissing ? ['Tool access: missing canonical toolAccess'] : []),
    `Recent run errors: ${recentErrors}`,
  ].join('\n');
}

function promptSummary(
  record: Record<string, any>,
  visibility: Record<string, any>,
): string | undefined {
  return compactText(
    visibility.fullPrompt ?? record.prompt ?? visibility.promptPreview,
    600,
  );
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
  return [`Scheduler jobs (${jobs.length})`, ...lines].join('\n');
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
  return [`Scheduler events (${events.length})`, ...lines].join('\n');
}

export function schedulerNotificationTargetsSummary(
  targets: unknown[],
): string {
  const lines = targets.map((target) => {
    const record =
      typeof target === 'object' && target !== null
        ? (target as Record<string, any>)
        : {};
    const executionContext =
      typeof record.executionContext === 'object' &&
      record.executionContext !== null
        ? (record.executionContext as Record<string, any>)
        : {};
    const notificationRoutes = Array.isArray(record.notificationRoutes)
      ? record.notificationRoutes
      : [];
    const routeSummary = notificationRoutes
      .map((route) =>
        typeof route === 'object' && route !== null
          ? routeLabel(route as Record<string, any>)
          : undefined,
      )
      .filter((route): route is string => Boolean(route))
      .join(', ');
    return [
      `- ${String(record.shortcut ?? 'unknown')}`,
      compactText(record.label, 120) ?? 'unnamed target',
      `execution_context ${executionContextSummary(executionContext)}`,
      `notification_routes ${notificationRoutes.length}${routeSummary ? ` (${routeSummary})` : ''}`,
    ].join(' | ');
  });
  return [`Scheduler notification targets (${targets.length})`, ...lines].join(
    '\n',
  );
}

function executionContextSummary(context: Record<string, any>): string {
  return [
    `conversation_jid=${String(context.conversationJid ?? 'unknown')}`,
    `thread_id=${context.threadId === null || context.threadId === undefined ? 'none' : String(context.threadId)}`,
    `workspace_key=${String(context.workspaceKey ?? 'unknown')}`,
  ].join(' ');
}

function routeLabel(route: Record<string, any>): string {
  return [
    compactText(route.label, 80) ?? 'route',
    String(route.conversationJid ?? 'unknown'),
    route.threadId === null || route.threadId === undefined
      ? 'none'
      : String(route.threadId),
  ].join(':');
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

function compactText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redactSensitiveText(value).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function formatAccessRequirementSummary(input: {
  capabilityRequirements: readonly string[];
  toolAccessRequirements: readonly string[];
  requiredMcpServers: readonly string[];
}): string {
  const toolAccessRequirements = visibleToolAccessRequirements(input);
  const parts = [
    input.capabilityRequirements.length
      ? `capabilities ${formatTools(input.capabilityRequirements)}`
      : undefined,
    toolAccessRequirements.length
      ? `tools ${formatDurableAccessRulesForUser(toolAccessRequirements)}`
      : undefined,
    input.requiredMcpServers.length
      ? `MCP servers ${formatTools(input.requiredMcpServers)}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join('; ') : '(none)';
}

function visibleToolAccessRequirements(input: {
  capabilityRequirements: readonly string[];
  toolAccessRequirements: readonly string[];
}): string[] {
  const capabilityIds = new Set(
    input.capabilityRequirements.map(capabilityIdFromRequirementLabel),
  );
  return input.toolAccessRequirements.filter((rule) => {
    const capabilityId = parseSemanticCapabilityRule(rule);
    return !capabilityId || !capabilityIds.has(capabilityId);
  });
}

function capabilityIdFromRequirementLabel(label: string): string {
  return label.split(/\s+via\s+/, 1)[0]?.trim() || label.trim();
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
