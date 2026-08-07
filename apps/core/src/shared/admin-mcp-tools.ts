export const ADMIN_MCP_TOOL_NAMES = [
  'settings_desired_state',
  'request_settings_update',
  'guided_action_preview',
  'admin_permission_list',
  'admin_permission_revoke',
  'service_restart',
  'register_agent',
] as const;

export type AdminMcpToolName = (typeof ADMIN_MCP_TOOL_NAMES)[number];

export const SCHEDULER_MCP_TOOL_NAMES = [
  'scheduler_list_models',
  'scheduler_upsert_job',
  'scheduler_get_job',
  'scheduler_list_jobs',
  'scheduler_list_notification_targets',
  'scheduler_update_job',
  'scheduler_delete_job',
  'scheduler_pause_job',
  'scheduler_resume_job',
  'scheduler_run_now',
  'scheduler_list_runs',
  'scheduler_list_events',
  'scheduler_wait_for_events',
  'scheduler_get_dead_letter',
] as const;

export type SchedulerMcpToolName = (typeof SCHEDULER_MCP_TOOL_NAMES)[number];

export const SCHEDULER_MUTATION_MCP_TOOL_NAMES = [
  'scheduler_upsert_job',
  'scheduler_update_job',
  'scheduler_delete_job',
  'scheduler_pause_job',
  'scheduler_resume_job',
  'scheduler_run_now',
] as const satisfies readonly SchedulerMcpToolName[];

// These scheduler rows predate the general durable-grant rule and remain
// startup catalog seeds. This list defines seed inventory only, not which
// Gantry tools may receive durable grants.
export const SEEDED_SCHEDULER_MCP_TOOL_NAMES = [
  'scheduler_list_models',
  'scheduler_get_job',
  'scheduler_list_jobs',
  'scheduler_list_notification_targets',
  'scheduler_run_now',
  'scheduler_list_runs',
  'scheduler_list_events',
  'scheduler_wait_for_events',
  'scheduler_get_dead_letter',
] as const satisfies readonly SchedulerMcpToolName[];

export type SeededSchedulerMcpToolName =
  (typeof SEEDED_SCHEDULER_MCP_TOOL_NAMES)[number];

export const BASELINE_GANTRY_MCP_TOOL_NAMES = [
  'attachment_open',
  'attachment_materialize',
  'canvas_read',
  'canvas_create',
  'canvas_update',
  'send_message',
  'ask_user_question',
  'render_status',
  'render_facts',
  'render_list',
  'render_table',
  'render_form',
  'render_media',
  'render_progress',
  'todo_update',
  'memory_search',
  'memory_save',
  'brain_search',
  'brain_query',
  'brain_write',
  'continuity_summary',
  'procedure_save',
  'request_skill_install',
  'request_skill_proposal',
  'pattern_candidate_decision',
  'proactive_surfacing_consent',
  'request_skill_dependency_install',
  'request_mcp_server',
  'request_access',
  'file',
  'agent_profile_read',
  'request_agent_profile_update',
  'mcp_list_tools',
  'mcp_search_tools',
  'mcp_describe_tool',
  'mcp_call_tool',
] as const;

export const MCP_PROXY_GANTRY_MCP_TOOL_NAMES = [
  'mcp_list_tools',
  'mcp_search_tools',
  'mcp_describe_tool',
  'mcp_call_tool',
] as const;

export const ASYNC_TASK_GANTRY_MCP_TOOL_NAMES = [
  'async_run_command',
  'async_mcp_call',
  'task_cancel',
  'task_get',
  'task_list',
  'task_wait',
] as const;

export const DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES = [
  'delegate_task',
  'task_message',
] as const;

// A tool is excluded from durable grants if granting it durably would let the
// agent change what it or another agent is permitted to do, alter runtime
// configuration or topology, or restart the service. The canonical tool-name
// registry lives here so every layer validates against the same closed set.
export const AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES = [
  'request_skill_install',
  'request_skill_proposal',
  'request_skill_dependency_install',
  'request_mcp_server',
  'request_access',
  'request_agent_profile_update',
  'admin_permission_revoke',
  'register_agent',
  'request_settings_update',
  'service_restart',
] as const;

// Decision actors persist a human consent or review decision. They must remain
// per-request reviewed so a durable tool grant cannot let the agent assert the
// human's decision on a later call.
export const DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES = [
  'memory_review_decision',
  'pattern_candidate_decision',
  'proactive_surfacing_consent',
] as const;

// Unscoped dispatchers that reach arbitrary tools or commands cannot be
// durably granted because an exact grant on the dispatcher cannot constrain
// the actual effect it dispatches to.
export const DURABLE_GRANT_EXCLUDED_DISPATCHERS = [
  'mcp_call_tool',
  'async_mcp_call',
  'async_run_command',
] as const;

// These dispatchers are intentionally never durable grants: their concrete
// target determines the authority required. The MCP variants are safe to pass
// through a runner-side permission gate because the host resolves and checks
// their exact target before executing it. async_run_command has no equivalent
// host-side target authorization, so it is deliberately excluded.
export const HOST_AUTHORIZED_MCP_PROXY_DISPATCHERS = [
  'mcp_call_tool',
  'async_mcp_call',
] as const;

// Delegation dispatchers start or steer another agent's work. An exact grant
// cannot bound the tools or commands that delegated agent may use.
export const DELEGATION_DISPATCHERS = [
  'delegate_task',
  'task_message',
] as const;

export const OPTIONAL_GANTRY_MCP_TOOL_NAMES = [
  ...SCHEDULER_MCP_TOOL_NAMES,
] as const;

export const REVIEWED_GANTRY_MCP_TOOL_NAMES = [
  'memory_patch',
  'memory_demote',
  'procedure_patch',
  'memory_dream',
  'memory_consolidate',
  'memory_review_pending',
  'memory_review_decision',
] as const;

export const GATED_GANTRY_MCP_TOOL_NAMES = [
  'browser_status',
  'browser_open',
  'browser_inspect',
  'browser_act',
  'browser_close',
] as const;

export const DEFAULT_GANTRY_MCP_TOOL_NAMES = [
  ...BASELINE_GANTRY_MCP_TOOL_NAMES,
  ...OPTIONAL_GANTRY_MCP_TOOL_NAMES,
] as const;

export const ALL_GANTRY_MCP_TOOL_NAMES = [
  ...DEFAULT_GANTRY_MCP_TOOL_NAMES,
  ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  ...GATED_GANTRY_MCP_TOOL_NAMES,
  ...REVIEWED_GANTRY_MCP_TOOL_NAMES,
  ...ADMIN_MCP_TOOL_NAMES,
] as const;

export type GantryMcpToolName = (typeof ALL_GANTRY_MCP_TOOL_NAMES)[number];

export type DurableGantryMcpToolBucket =
  | 'grantable-exact'
  | 'runtime-projection'
  | 'unscoped-dispatcher'
  | 'delegation'
  | 'authority-changing'
  | 'decision-actor';

export const ADMIN_MCP_TOOL_FULL_NAMES = ADMIN_MCP_TOOL_NAMES.map(
  (toolName) => `mcp__gantry__${toolName}`,
) as readonly `mcp__gantry__${AdminMcpToolName}`[];

export const SCHEDULER_MCP_TOOL_FULL_NAMES = SCHEDULER_MCP_TOOL_NAMES.map(
  (toolName) => `mcp__gantry__${toolName}`,
) as readonly `mcp__gantry__${SchedulerMcpToolName}`[];

export const SEEDED_SCHEDULER_MCP_TOOL_FULL_NAMES =
  SEEDED_SCHEDULER_MCP_TOOL_NAMES.map(
    (toolName) => `mcp__gantry__${toolName}`,
  ) as readonly `mcp__gantry__${SeededSchedulerMcpToolName}`[];

const ADMIN_MCP_TOOL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_NAMES);
const ADMIN_MCP_TOOL_FULL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_FULL_NAMES);
const SEEDED_SCHEDULER_MCP_TOOL_NAME_SET = new Set<string>(
  SEEDED_SCHEDULER_MCP_TOOL_NAMES,
);
const AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
);
const DECISION_ACTOR_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(
  DECISION_ACTOR_GANTRY_MCP_TOOL_NAMES,
);
const DURABLE_GRANT_EXCLUDED_DISPATCHER_SET = new Set<string>(
  DURABLE_GRANT_EXCLUDED_DISPATCHERS,
);
const HOST_AUTHORIZED_MCP_PROXY_DISPATCHER_SET = new Set<string>(
  HOST_AUTHORIZED_MCP_PROXY_DISPATCHERS,
);
const DELEGATION_DISPATCHER_SET = new Set<string>(DELEGATION_DISPATCHERS);
const ALL_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);
const GANTRY_MCP_TOOL_FULL_NAME_PATTERN = /^mcp__gantry__([a-z][a-z0-9_]*)$/;

export const GRANTABLE_EXACT_GANTRY_MCP_TOOL_NAMES =
  ALL_GANTRY_MCP_TOOL_NAMES.filter(
    (toolName) =>
      !(GATED_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(toolName) &&
      !AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET.has(toolName) &&
      !DECISION_ACTOR_GANTRY_MCP_TOOL_NAME_SET.has(toolName) &&
      !DURABLE_GRANT_EXCLUDED_DISPATCHER_SET.has(toolName) &&
      !DELEGATION_DISPATCHER_SET.has(toolName),
  );

export function adminMcpToolFullName(
  toolName: AdminMcpToolName,
): `mcp__gantry__${AdminMcpToolName}` {
  return `mcp__gantry__${toolName}`;
}

export function adminMcpToolIdForFullName(toolFullName: string): string {
  return `tool:${toolFullName}`;
}

export function isAdminMcpToolName(value: string): value is AdminMcpToolName {
  return ADMIN_MCP_TOOL_NAME_SET.has(value);
}

export function isAdminMcpToolFullName(value: string): boolean {
  return ADMIN_MCP_TOOL_FULL_NAME_SET.has(value);
}

export function isSeededGantryMcpToolFullName(value: string): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return (
    isAdminMcpToolFullName(value) ||
    (toolName !== null && SEEDED_SCHEDULER_MCP_TOOL_NAME_SET.has(toolName))
  );
}

export function parseExactGantryMcpToolName(value: string): string | null {
  return GANTRY_MCP_TOOL_FULL_NAME_PATTERN.exec(value)?.[1] ?? null;
}

export function isKnownGantryMcpToolFullName(value: string): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return toolName !== null && ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName);
}

export function isAuthorityChangingGantryMcpToolFullName(
  value: string,
): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return (
    toolName !== null &&
    AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET.has(toolName)
  );
}

export function isDurableGrantExcludedDispatcherFullName(
  value: string,
): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return (
    toolName !== null && DURABLE_GRANT_EXCLUDED_DISPATCHER_SET.has(toolName)
  );
}

export function isHostAuthorizedMcpProxyDispatcherFullName(
  value: string,
): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return (
    toolName !== null && HOST_AUTHORIZED_MCP_PROXY_DISPATCHER_SET.has(toolName)
  );
}

export function isDelegationDispatcherFullName(value: string): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return toolName !== null && DELEGATION_DISPATCHER_SET.has(toolName);
}

export function isDecisionActorGantryMcpToolFullName(value: string): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return (
    toolName !== null && DECISION_ACTOR_GANTRY_MCP_TOOL_NAME_SET.has(toolName)
  );
}

export function classifyDurableGantryMcpToolName(
  value: string,
): DurableGantryMcpToolBucket | null {
  if (!ALL_GANTRY_MCP_TOOL_NAME_SET.has(value)) return null;
  if ((GATED_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(value)) {
    return 'runtime-projection';
  }
  if (DURABLE_GRANT_EXCLUDED_DISPATCHER_SET.has(value)) {
    return 'unscoped-dispatcher';
  }
  if (DELEGATION_DISPATCHER_SET.has(value)) return 'delegation';
  if (AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET.has(value)) {
    return 'authority-changing';
  }
  if (DECISION_ACTOR_GANTRY_MCP_TOOL_NAME_SET.has(value)) {
    return 'decision-actor';
  }
  return 'grantable-exact';
}

export function isDurableGantryMcpToolFullName(value: string): boolean {
  const toolName = parseExactGantryMcpToolName(value);
  return (
    toolName !== null &&
    classifyDurableGantryMcpToolName(toolName) === 'grantable-exact'
  );
}

export function adminMcpToolNameFromFullName(
  value: string,
): AdminMcpToolName | null {
  if (!isAdminMcpToolFullName(value)) return null;
  const name = value.slice('mcp__gantry__'.length);
  return isAdminMcpToolName(name) ? name : null;
}

export function isGantryMcpWildcardRule(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === 'mcp__gantry__*' ||
    trimmed.startsWith('mcp__gantry__*(') ||
    trimmed.startsWith('mcp__gantry__(')
  );
}
