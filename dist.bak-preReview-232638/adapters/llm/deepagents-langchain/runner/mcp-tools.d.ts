import { type StructuredToolInterface } from '@langchain/core/tools';
import { type ThirdPartyMcpGateConfig } from './third-party-mcp-gate.js';
import { type DeclarativeToolRule, type DeclarativeToolRuleDenial, type RunScopedToolSuccessLedger } from '../../../../runner/tool-gate-core.js';
import { type CallableAgentToolManifestEntry } from '../../../../application/core-tools/callable-agent-tools.js';
export interface ExternalServerConfig {
    type?: 'stdio' | 'http' | 'sse';
    transport?: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
}
export interface ConnectedMcpTools {
    tools: StructuredToolInterface[];
    close: () => Promise<void>;
}
export interface ConnectGantryMcpInput {
    configuredAllowedTools: readonly string[];
    toolRules?: readonly DeclarativeToolRule[];
    toolSuccessLedger?: RunScopedToolSuccessLedger;
    onToolRuleDenial?: (toolName: string, denial: DeclarativeToolRuleDenial) => void;
    toolNetworkEnv?: Record<string, string>;
    hideAuthorityTools: boolean;
    callableAgentManifest?: readonly CallableAgentToolManifestEntry[];
    gate: Omit<ThirdPartyMcpGateConfig, 'configuredAllowedTools'>;
    shellSignal?: AbortSignal;
    shellCwd?: string;
}
export declare function connectGantryAndThirdPartyMcpTools(input: ConnectGantryMcpInput): Promise<ConnectedMcpTools>;
export declare function dropCollidingThirdPartyTools(serverName: string, tools: readonly StructuredToolInterface[], selectedGantrySet: ReadonlySet<string>): StructuredToolInterface[];
export declare function shouldProjectGantryShellTool(input: {
    shellEnabledEnv: string | undefined;
    configuredAllowedTools: readonly string[];
}): boolean;
export declare function shouldProjectGantryFilesystemTools(input: {
    filesystemEnabledEnv: string | undefined;
}): boolean;
export declare function rejectExternalThirdPartyMcpServer(name: string, config: ExternalServerConfig | null | undefined): void;
