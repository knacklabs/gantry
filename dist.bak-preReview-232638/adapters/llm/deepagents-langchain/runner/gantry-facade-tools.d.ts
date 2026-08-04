import type { StructuredToolInterface } from '@langchain/core/tools';
import { type PermissionIpcRuntimeEnv } from '../../../../runner/permission-ipc-client.js';
import { type ThirdPartyMcpGateConfig } from './third-party-mcp-gate.js';
export declare const DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES: readonly ["WebSearch", "WebRead", "FileSearch", "FileRead", "FileEdit", "FileWrite", "AgentDelegation"];
export type DeepAgentsFacadeToolName = (typeof DEEPAGENTS_GANTRY_FACADE_TOOL_NAMES)[number];
export interface GantryFacadeToolsConfig {
    workspaceFolder: string;
    memoryBlock: string;
    configuredAllowedTools: readonly string[];
    toolNetworkEnv?: Record<string, string>;
    gateContext: ThirdPartyMcpGateConfig['gateContext'];
    permissionEnv: PermissionIpcRuntimeEnv;
    lockedAccessPreset: boolean;
    filesystemToolsEnabled: boolean;
    asyncTaskToolsEnabled?: boolean;
    delegateTaskTool?: StructuredToolInterface;
    cwd?: string;
    signal?: AbortSignal;
}
export declare function createGantryFacadeTools(config: GantryFacadeToolsConfig): StructuredToolInterface[];
export declare function gantryFacadePolicyToolRequest(toolName: DeepAgentsFacadeToolName, input: unknown): {
    toolName: string;
    toolInput: unknown;
};
