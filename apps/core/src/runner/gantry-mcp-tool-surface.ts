import { ADMIN_MCP_TOOL_NAMES } from '../shared/admin-mcp-tools.js';
import {
  selectedMemoryIpcActionsFromToolRules,
  type GantryMemoryIpcAction,
} from '../shared/memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';

export const BASELINE_GANTRY_MCP_TOOL_NAMES = [
  'send_message',
  'ask_user_question',
  'memory_search',
  'memory_save',
  'continuity_summary',
  'procedure_save',
  'request_skill_install',
  'request_skill_proposal',
  'request_skill_dependency_install',
  'request_mcp_server',
  'request_permission',
  'capability_status',
  'capability_search',
  'propose_capability',
  'manage_capability',
  'file',
  'mcp_list_tools',
  'mcp_call_tool',
] as const;

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
  ...GATED_GANTRY_MCP_TOOL_NAMES,
  ...REVIEWED_GANTRY_MCP_TOOL_NAMES,
  ...ADMIN_MCP_TOOL_NAMES,
] as const;

const ALL_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);

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
): string[] {
  const names = new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  if (isBrowserSelected(configuredTools)) {
    for (const toolName of GATED_GANTRY_MCP_TOOL_NAMES) names.add(toolName);
  }
  for (const configuredTool of configuredTools) {
    const name = gantryMcpToolNameFromFullName(configuredTool);
    if (
      name &&
      !(GATED_GANTRY_MCP_TOOL_NAMES as readonly string[]).includes(name)
    ) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function isBrowserSelected(configuredTools: readonly string[]): boolean {
  return configuredTools.some(isCanonicalBrowserCapabilityRule);
}

export function selectedGantryMcpFullToolNames(
  configuredTools: readonly string[],
): string[] {
  return selectedGantryMcpToolNames(configuredTools).map(gantryMcpFullToolName);
}

export function parseEnabledGantryMcpToolNames(
  raw: string | undefined,
): Set<string> {
  if (!raw?.trim()) {
    return new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
    }
    const enabled = new Set<string>(DEFAULT_GANTRY_MCP_TOOL_NAMES);
    for (const item of parsed) {
      const toolName = typeof item === 'string' ? item.trim() : '';
      if (ALL_GANTRY_MCP_TOOL_NAME_SET.has(toolName)) enabled.add(toolName);
    }
    return enabled;
  } catch {
    return new Set(DEFAULT_GANTRY_MCP_TOOL_NAMES);
  }
}

export function selectedMemoryIpcActions(
  configuredTools: readonly string[],
): GantryMemoryIpcAction[] {
  return selectedMemoryIpcActionsFromToolRules(configuredTools);
}
