import { ALL_GANTRY_MCP_TOOL_NAMES, ASYNC_TASK_GANTRY_MCP_TOOL_NAMES, AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES, BASELINE_GANTRY_MCP_TOOL_NAMES, DEFAULT_GANTRY_MCP_TOOL_NAMES, DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES, GATED_GANTRY_MCP_TOOL_NAMES, OPTIONAL_GANTRY_MCP_TOOL_NAMES, REVIEWED_GANTRY_MCP_TOOL_NAMES } from '../shared/admin-mcp-tools.js';
import { type GantryMemoryIpcAction, type MemoryIpcActionSelectionOptions } from '../shared/memory-ipc-actions.js';
export { ALL_GANTRY_MCP_TOOL_NAMES, ASYNC_TASK_GANTRY_MCP_TOOL_NAMES, AUTHORITY_CHANGING_GANTRY_MCP_TOOL_NAMES, BASELINE_GANTRY_MCP_TOOL_NAMES, DEFAULT_GANTRY_MCP_TOOL_NAMES, DELEGATED_TASK_GANTRY_MCP_TOOL_NAMES, GATED_GANTRY_MCP_TOOL_NAMES, OPTIONAL_GANTRY_MCP_TOOL_NAMES, REVIEWED_GANTRY_MCP_TOOL_NAMES, };
export declare const NO_PERMISSION_HIDDEN_GANTRY_MCP_TOOL_NAMES: readonly ["request_skill_install", "request_skill_proposal", "request_skill_dependency_install", "request_mcp_server", "request_access", "request_agent_profile_update", "admin_permission_revoke", "register_agent", "request_settings_update", "service_restart", "async_run_command", "async_mcp_call", "task_cancel", "task_get", "task_list", "delegate_task", "task_message", "scheduler_list_models", "scheduler_upsert_job", "scheduler_get_job", "scheduler_list_jobs", "scheduler_list_notification_targets", "scheduler_update_job", "scheduler_delete_job", "scheduler_pause_job", "scheduler_resume_job", "scheduler_run_now", "scheduler_list_runs", "scheduler_list_events", "scheduler_wait_for_events", "scheduler_get_dead_letter", "memory_patch", "memory_demote", "procedure_patch", "memory_dream", "memory_consolidate", "memory_review_pending", "memory_review_decision"];
export declare function isAuthorityChangingGantryMcpToolName(value: string): boolean;
export declare function isNoPermissionHiddenGantryMcpToolName(value: string): boolean;
export interface GantryMcpToolSelectionOptions extends MemoryIpcActionSelectionOptions {
    excludeAuthorityTools?: boolean;
    asyncTaskToolsEnabled?: boolean;
}
export declare function gantryMcpFullToolName(toolName: string): string;
export declare function gantryMcpToolNameFromFullName(value: string): string | null;
export declare function selectedGantryMcpToolNames(configuredTools: readonly string[], options?: GantryMcpToolSelectionOptions): string[];
export declare function selectedGantryMcpFullToolNames(configuredTools: readonly string[], options?: GantryMcpToolSelectionOptions): string[];
export declare function parseEnabledGantryMcpToolNames(raw: string | undefined, options?: {
    lockedPreset?: boolean;
}): Set<string>;
export declare function selectedMemoryIpcActions(configuredTools: readonly string[], options?: MemoryIpcActionSelectionOptions): GantryMemoryIpcAction[];
