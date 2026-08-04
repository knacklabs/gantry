export type AgentAccessPreset = 'full' | 'locked';
export declare const DEFAULT_AGENT_ACCESS_PRESET: AgentAccessPreset;
export interface AgentAccessPolicy {
    preset: AgentAccessPreset;
    mountedToolFamilies: {
        authorityTools: boolean;
        adminTools: boolean;
    };
    permissionMode: 'default' | 'deny';
    installMode: 'live' | 'preprovisioned';
}
export declare function resolveAgentAccessPolicy(preset: AgentAccessPreset | undefined): AgentAccessPolicy;
export declare const LOCKED_DENIED_IPC_TASK_TYPES: ReadonlySet<string>;
export declare function isLockedDeniedIpcTaskType(taskType: string): boolean;
export type AgentLockStatus = 'locked' | 'full' | 'unknown';
export declare function resolveAgentLockStatus(sourceAgentFolder: string): AgentLockStatus;
