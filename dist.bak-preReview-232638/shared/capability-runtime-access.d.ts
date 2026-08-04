export type CapabilityRuntimeAccessSourceType = 'local_cli' | 'skill_action' | 'mcp_server' | 'builtin_tool' | 'configured_adapter';
export interface CapabilityRuntimeAccessBase {
    selectedCapabilityId: string;
    sourceType: CapabilityRuntimeAccessSourceType;
    auditLabel: string;
}
export interface CommandBoundNetworkBinding {
    commandRules: string[];
    hosts: string[];
}
export interface LocalCliCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
    sourceType: 'local_cli';
    commandRules: string[];
    credentialDirs: string[];
    networkBindings: CommandBoundNetworkBinding[];
}
export interface SkillActionCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
    sourceType: 'skill_action';
    skillId: string;
    selectedAction: string;
    declaredEnvRefs: string[];
    commandRules: string[];
    networkBindings: CommandBoundNetworkBinding[];
}
export interface McpServerCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
    sourceType: 'mcp_server';
    reviewedServerId: string;
    allowedTools: string[];
    credentialRefs: string[];
    networkHosts: string[];
}
export interface BuiltinToolCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
    sourceType: 'builtin_tool';
    runtimeToolRules: string[];
}
export interface ConfiguredAdapterCapabilityRuntimeAccess extends CapabilityRuntimeAccessBase {
    sourceType: 'configured_adapter';
    adapterRef: string;
}
export type CapabilityRuntimeAccess = LocalCliCapabilityRuntimeAccess | SkillActionCapabilityRuntimeAccess | McpServerCapabilityRuntimeAccess | BuiltinToolCapabilityRuntimeAccess | ConfiguredAdapterCapabilityRuntimeAccess;
export declare function reviewedExternalMcpToolPatternsFromRuntimeAccess(runtimeAccess: readonly CapabilityRuntimeAccess[] | undefined): string[];
export declare function reviewedExternalMcpToolNamesFromRuntimeAccess(runtimeAccess: readonly CapabilityRuntimeAccess[] | undefined, options?: {
    serverNames?: readonly string[];
}): string[];
