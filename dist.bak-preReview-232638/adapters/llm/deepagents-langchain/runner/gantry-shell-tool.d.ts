import type { StructuredToolInterface } from '@langchain/core/tools';
import { type PermissionIpcRuntimeEnv } from '../../../../runner/permission-ipc-client.js';
import { type ThirdPartyMcpGateConfig } from './third-party-mcp-gate.js';
export declare const GANTRY_SHELL_TOOL_NAME = "RunCommand";
export declare const SHELL_POLICY_TOOL_NAME = "Bash";
export declare const SHELL_CHILD_NETWORK_ENV_KEYS: readonly ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "GRPC_PROXY", "grpc_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "GODEBUG", "GANTRY_EGRESS_PROXY_URL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "PIP_CERT", "AWS_CA_BUNDLE", "CARGO_HTTP_CAINFO", "DENO_CERT"];
export interface GantryShellToolConfig {
    workspaceFolder: string;
    memoryBlock: string;
    configuredAllowedTools: readonly string[];
    gateContext: ThirdPartyMcpGateConfig['gateContext'];
    permissionEnv: PermissionIpcRuntimeEnv;
    lockedAccessPreset: boolean;
    cwd?: string;
    signal?: AbortSignal;
    toolNetworkEnv?: Record<string, string>;
}
export declare function createGantryShellTool(config: GantryShellToolConfig): StructuredToolInterface;
