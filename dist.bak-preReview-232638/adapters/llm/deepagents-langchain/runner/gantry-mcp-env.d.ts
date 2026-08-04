import { type CallableAgentToolManifestEntry } from '../../../../application/core-tools/callable-agent-tools.js';
export interface GantryMcpEnvInput {
    configuredAllowedTools: readonly string[];
    hideAuthorityTools: boolean;
    memoryBlock?: string;
    processEnv: NodeJS.ProcessEnv;
    callableAgentManifest?: readonly CallableAgentToolManifestEntry[];
}
export interface GantryMcpProjection {
    env: Record<string, string>;
    selectedToolNames: string[];
    browserIpcEnabled: boolean;
    asyncTaskToolsEnabled: boolean;
}
export declare function buildGantryMcpProjection(input: GantryMcpEnvInput): GantryMcpProjection;
