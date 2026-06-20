import {
  ADMIN_MCP_TOOL_NAMES,
  AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES,
} from '../shared/admin-mcp-tools.js';
import { getRuntimeSettingsForConfig } from './index.js';

// Locked agents have zero access to authority-changing/request/admin/settings
// tools. The preset is resolved once at config load into a policy object that
// drives tool mounting, permission prompts, and parent-side IPC denial. Default
// is `full` (today's behavior, zero regression).
export type AgentAccessPreset = 'full' | 'locked';

export const DEFAULT_AGENT_ACCESS_PRESET: AgentAccessPreset = 'full';

export interface AgentAccessPolicy {
  preset: AgentAccessPreset;
  // When false, authority-changing/request/admin Gantry MCP tools are never
  // mounted and any forged IPC for them is denied parent-side.
  mountedToolFamilies: {
    authorityTools: boolean;
    adminTools: boolean;
  };
  // `deny` auto-denies permission prompts with "capability not provisioned":
  // a locked agent works only with pre-provisioned skills/MCP/capabilities.
  permissionMode: 'default' | 'deny';
  // Locked agents never install skills/dependencies/MCP servers during a run.
  installMode: 'live' | 'preprovisioned';
}

const FULL_ACCESS_POLICY: AgentAccessPolicy = {
  preset: 'full',
  mountedToolFamilies: { authorityTools: true, adminTools: true },
  permissionMode: 'default',
  installMode: 'live',
};

const LOCKED_ACCESS_POLICY: AgentAccessPolicy = {
  preset: 'locked',
  mountedToolFamilies: { authorityTools: false, adminTools: false },
  permissionMode: 'deny',
  installMode: 'preprovisioned',
};

export function resolveAgentAccessPolicy(
  preset: AgentAccessPreset | undefined,
): AgentAccessPolicy {
  return preset === 'locked' ? LOCKED_ACCESS_POLICY : FULL_ACCESS_POLICY;
}

// IPC task types a locked agent may never invoke. The parent IPC dispatcher is
// the security boundary: a forged IPC file in a locked agent's runner workspace
// is denied here even though the child never mounted the tool. `request_access`
// reaches the host as the `request_permission` IPC task type.
export const LOCKED_DENIED_IPC_TASK_TYPES: ReadonlySet<string> =
  new Set<string>([
    ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES.map((toolName) =>
      toolName === 'request_access' ? 'request_permission' : toolName,
    ),
    'async_run_command',
    'delegate_task',
    'task_get',
    'task_list',
    'task_cancel',
    'task_message',
    ...ADMIN_MCP_TOOL_NAMES,
  ]);

export function isLockedDeniedIpcTaskType(taskType: string): boolean {
  return LOCKED_DENIED_IPC_TASK_TYPES.has(taskType);
}

// Tri-state lock status for parent-side authority gates. `unknown` means the
// settings desired state could not be read; authority-bearing paths must treat
// it as locked (control plane owns authority — fail closed), while ordinary
// non-authority task types are unaffected.
export type AgentLockStatus = 'locked' | 'full' | 'unknown';

export function resolveAgentLockStatus(
  sourceAgentFolder: string,
): AgentLockStatus {
  try {
    return getRuntimeSettingsForConfig().agents?.[sourceAgentFolder]
      ?.accessPreset === 'locked'
      ? 'locked'
      : 'full';
  } catch {
    return 'unknown';
  }
}
