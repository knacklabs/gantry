import {
  ADMIN_MCP_TOOL_NAMES,
  ALL_GANTRY_MCP_TOOL_NAMES,
  ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  BASELINE_GANTRY_MCP_TOOL_NAMES,
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  GATED_GANTRY_MCP_TOOL_NAMES,
  MCP_PROXY_GANTRY_MCP_TOOL_NAMES,
  OPTIONAL_GANTRY_MCP_TOOL_NAMES,
  REVIEWED_GANTRY_MCP_TOOL_NAMES,
} from '../shared/admin-mcp-tools.js';
import {
  selectedMemoryIpcActionsFromToolRules,
  type GantryMemoryIpcAction,
  type MemoryIpcActionSelectionOptions,
} from '../shared/memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';

// Authority-changing Gantry tools let an agent request new install/setup/access
// authority for itself. In the fixed-image worker product mode they are hidden
// from user-facing live agents and scheduled jobs: workers never install tools,
// skills, MCP servers, or dependencies during a run. Admin tools are tracked
// separately in ADMIN_MCP_TOOL_NAMES. The canonical constants live in shared;
// these re-exports preserve the runner's public tool-surface API.
export {
  ALL_GANTRY_MCP_TOOL_NAMES,
  ASYNC_TASK_GANTRY_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
  BASELINE_GANTRY_MCP_TOOL_NAMES,
  DEFAULT_GANTRY_MCP_TOOL_NAMES,
  DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES,
  GATED_GANTRY_MCP_TOOL_NAMES,
  MCP_PROXY_GANTRY_MCP_TOOL_NAMES,
  OPTIONAL_GANTRY_MCP_TOOL_NAMES,
  REVIEWED_GANTRY_MCP_TOOL_NAMES,
};

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

const ALL_GANTRY_MCP_TOOL_NAME_SET = new Set<string>(ALL_GANTRY_MCP_TOOL_NAMES);

export interface GantryMcpToolSelectionOptions extends MemoryIpcActionSelectionOptions {
  // When true, omit authority-changing request tools from the projected surface
  // (fixed-image worker / no-permission-tools mode).
  excludeAuthorityTools?: boolean;
  // Async command task tools require a durable task repository and an enforcing
  // runner sandbox. They are projected only when the host says that executor is
  // available for this run.
  asyncTaskToolsEnabled?: boolean;
  // Caller-bounded jobs already receive their exact reviewed tools. Hide the
  // generic proxy/inventory path so the model cannot escape that closed set.
  excludeMcpProxyTools?: boolean;
  includeBaselineTools?: boolean;
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
  const names = new Set<string>(
    options.includeBaselineTools === false ? [] : DEFAULT_GANTRY_MCP_TOOL_NAMES,
  );
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
  if (options.excludeMcpProxyTools) {
    for (const toolName of MCP_PROXY_GANTRY_MCP_TOOL_NAMES) {
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
  options: GantryMcpToolSelectionOptions = {},
): GantryMemoryIpcAction[] {
  return selectedMemoryIpcActionsFromToolRules(configuredTools, options);
}
