import { ADMIN_MCP_TOOL_NAMES, AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES, } from '../shared/admin-mcp-tools.js';
import { getRuntimeSettingsForConfig } from './index.js';
export const DEFAULT_AGENT_ACCESS_PRESET = 'full';
const FULL_ACCESS_POLICY = {
    preset: 'full',
    mountedToolFamilies: { authorityTools: true, adminTools: true },
    permissionMode: 'default',
    installMode: 'live',
};
const LOCKED_ACCESS_POLICY = {
    preset: 'locked',
    mountedToolFamilies: { authorityTools: false, adminTools: false },
    permissionMode: 'deny',
    installMode: 'preprovisioned',
};
export function resolveAgentAccessPolicy(preset) {
    return preset === 'locked' ? LOCKED_ACCESS_POLICY : FULL_ACCESS_POLICY;
}
// IPC task types a locked agent may never invoke. The parent IPC dispatcher is
// the security boundary: a forged IPC file in a locked agent's runner workspace
// is denied here even though the child never mounted the tool. `request_access`
// reaches the host as the `request_permission` IPC task type.
export const LOCKED_DENIED_IPC_TASK_TYPES = new Set([
    ...AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES.map((toolName) => toolName === 'request_access' ? 'request_permission' : toolName),
    'async_run_command',
    'async_mcp_call',
    'delegate_task',
    'task_get',
    'task_list',
    'task_cancel',
    'task_message',
    ...ADMIN_MCP_TOOL_NAMES,
]);
export function isLockedDeniedIpcTaskType(taskType) {
    return LOCKED_DENIED_IPC_TASK_TYPES.has(taskType);
}
export function resolveAgentLockStatus(sourceAgentFolder) {
    try {
        return getRuntimeSettingsForConfig().agents?.[sourceAgentFolder]
            ?.accessPreset === 'locked'
            ? 'locked'
            : 'full';
    }
    catch {
        return 'unknown';
    }
}
