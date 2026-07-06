import {
  ADMIN_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
} from '../shared/admin-mcp-tools.js';
import {
  selectedMemoryIpcActionsFromToolRules,
  type GantryMemoryIpcAction,
  type MemoryIpcActionSelectionOptions,
} from '../shared/memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';

export const BASELINE_GANTRY_MCP_TOOL_NAMES = [
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
  'mcp_describe_tool',
  'mcp_call_tool',
] as const;

export const ASYNC_TASK_GANTRY_MCP_TOOL_NAMES = [
  'async_run_command',
  'async_mcp_call',
  'task_cancel',
  'task_get',
  'task_list',
] as const;

export const DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES = [
  'delegate_task',
  'task_message',
] as const;

// Authority-changing Gantry tools let an agent request new install/setup/access
// authority for itself. In the fixed-image worker product mode they are hidden
// from user-facing live agents and scheduled jobs: workers never install tools,
// skills, MCP servers, or dependencies during a run. Admin tools are tracked
// separately in ADMIN_MCP_TOOL_NAMES. The canonical names live in the shared
// admin-mcp-tools module; this re-export keeps the runner the agent-facing
// source of truth for the tool surface.
export { AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES };

export const OPTIONAL_GANTRY_MCP_TOOL_NAMES = [
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

export const REVIEWED_GANTRY_MCP_TOOL_NAMES = [
  'memory_patch',
  'memory_demote',
  'procedure_patch',
  'memory_dream',
  'memory_consolidate',
  'memory_review_pending',
  'memory_review_decision',
] as const;

const REVIEWER_MEMORY_REVIEW_GANTRY_MCP_TOOL_NAMES = [
  'memory_review_pending',
  'memory_review_decision',
] as const;

export const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES = [
  ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  ...OPTIONAL_GANTRY_MCP_TOOL_NAMES,
  ...REVIEWED_GANTRY_MCP_TOOL_NAMES,
] as const;

const AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
);

const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(
  NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES,
);

const ADMIN_MCP_TOOL_NAME_SET = new Set<string>(ADMIN_MCP_TOOL_NAMES);
export function isAuthorityChangingGantryMcpToolName(value: string): boolean {
  return AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAME_SET.has(value);
}

export function isNoPermissionHiddenGantryMcpToolName(value: string): boolean {
  return NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(value);
}

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

const ALL_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);

export interface GantryMcpToolSelectionOptions extends MemoryIpcActionSelectionOptions {
  // When true, omit authority-changing request tools from the projected surface
  // (fixed-image worker / no-permission-tools mode).
  excludeAuthorityTools?: boolean;
  // Async command task tools require a durable task repository and an enforcing
  // runner sandbox. They are projected only when the host says that executor is
  // available for this run.
  asyncTaskToolsEnabled?: boolean;
}

export function gantryMcpFullToolName(toolName: string): string {
  return `mcp__gantry__${toolName}`;
}

export function gantryMcpToolNameFromFullName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('mcp__gantry__')) return null;
  const toolName = trimmed.slice('mcp__gantry__'.length);
  return ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName) ? toolName : null;
}

export function selectedGantryMcpToolNames(
  configuredTools: readonly string[],
  options: GantryMcpToolSelectionOptions = {},
): string[] {
  const names = new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  if (options.asyncTaskToolsEnabled && !options.excludeAuthorityTools) {
    for (const toolName of ASYNC_TASK_GANTRY_MCP_TOOL_NAMES)
      names.add(toolName);
    if (configuredTools.includes('AgentDelegation')) {
      for (const toolName of DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES)
        names.add(toolName);
    }
  }
  if (isBrowserSelected(configuredTools)) {
    for (const toolName of GATED_GANTRY_MCP_TOOL_NAMES) names.add(toolName);
  }
  if (options.memoryReviewerIsControlApprover) {
    for (const toolName of REVIEWER_MEMORY_REVIEW_GANTRY_MCP_TOOL_NAMES) {
      names.add(toolName);
    }
  }
  for (const configuredTool of configuredTools) {
    const name = gantryMcpToolNameFromFullName(configuredTool);
    if (
      name &&
      (options.asyncTaskToolsEnabled ||
        ![
          ...ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
          ...DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
        ].includes(name as never)) &&
      !(GATED_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      names.add(name);
    }
  }
  if (options.excludeAuthorityTools) {
    for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
      names.delete(toolName);
    }
    for (const toolName of ADMIN_MCP_TOOL_NAMES) {
      names.delete(toolName);
    }
  }
  return [...names].sort();
}

function isBrowserSelected(configuredTools: readonly string[]): boolean {
  return configuredTools.some(isCanonicalBrowserCapabilityRule);
}

export function selectedGantryMcpFullToolNames(
  configuredTools: readonly string[],
  options: GantryMcpToolSelectionOptions = {},
): string[] {
  return selectedGantryMcpToolNames(configuredTools, options).map(
    gantryMcpFullToolName,
  );
}

// Locked agents start from the default surface minus every authority-changing
// and admin tool. This is the fail-closed base: an unset or corrupt env can
// never restore authority tools for a locked agent.
function lockedDefaultGantryMcpToolNames(): Set<string> {
  const names = new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  for (const toolName of NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES) {
    names.delete(toolName);
  }
  for (const toolName of ADMIN_MCP_TOOL_NAMES) {
    names.delete(toolName);
  }
  return names;
}

export function parseEnabledGantryMcpToolNames(
  raw: string | undefined,
  options: { lockedPreset?: boolean } = {},
): Set<string> {
  // For locked agents a malformed/unset env must fail closed to the locked
  // base set, never to the full default set that still carries authority tools.
  const fallback = (): Set<string> =>
    options.lockedPreset
      ? lockedDefaultGantryMcpToolNames()
      : new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  const base = (): Set<string> =>
    options.lockedPreset
      ? lockedDefaultGantryMcpToolNames()
      : new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  if (!raw?.trim()) {
    return fallback();
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return fallback();
    }
    const enabled = base();
    for (const item of parsed) {
      const toolName = typeof item === 'string' ? item.trim() : '';
      if (!ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName)) continue;
      if (
        options.lockedPreset &&
        (NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAME_SET.has(toolName) ||
          ADMIN_MCP_TOOL_NAME_SET.has(toolName))
      ) {
        continue;
      }
      enabled.add(toolName);
    }
    return enabled;
  } catch {
    return fallback();
  }
}

export function selectedMemoryIpcActions(
  configuredTools: readonly string[],
  options: MemoryIpcActionSelectionOptions = {},
): GantryMemoryIpcAction[] {
  return selectedMemoryIpcActionsFromToolRules(configuredTools, options);
}
