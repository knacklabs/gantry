import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import type { MaterializedMcpServer } from '../domain/mcp/mcp-servers.js';
import type { EgressNetworkAttribution } from './egress-gateway.js';
import type { AgentInput } from './agent-spawn-types.js';
import { type CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import { type AgentEngine } from '../shared/agent-engine.js';
export declare const PROTECTED_FILESYSTEM_PATHS_ENV = "GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON";
export declare const PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV = "GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON";
export declare const PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV = "GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON";
export declare const LOCAL_CLI_CREDENTIAL_DIRS_ENV = "GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON";
export declare const SANDBOX_RUNTIME_MODEL_GATEWAY_HOST = "model-gateway.gantry.internal";
export declare function writeProtectedFilesystemEnv(input: {
    env: NodeJS.ProcessEnv;
    protectedReadPaths: readonly string[];
    protectedWritePaths: readonly string[];
    localCliCredentialPaths: readonly string[];
}): void;
export interface SandboxRuntimeModelGatewayProjection {
    modelCredentialEnv?: Record<string, string>;
    allowedNetworkHosts: string[];
    privateNetworkHostMappings: Array<{
        authority: string;
        connectHost: string;
    }>;
}
export interface ResolvedRunnerMcpProjection {
    reviewedMcpToolNames: string[];
    projectedMcpSourceIds: string[];
}
export declare function validateRunnerAllowedTools(rules: readonly string[], runtimeAccess?: AgentInput['runtimeAccess']): string | null;
export declare function pickSafeHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function pickPreparedExecutionEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function pickSelectedCapabilityEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function resolveHomeRelativePaths(values: readonly string[], source: NodeJS.ProcessEnv): string[];
export declare function localCliCredentialPathHintsFromRuntimeAccess(runtimeAccess: AgentInput['runtimeAccess']): string[];
export declare function egressNetworkAttributionFromRuntimeAccess(runtimeAccess: AgentInput['runtimeAccess']): EgressNetworkAttribution[];
export declare function attachMcpSourceNetworkHosts(runtimeAccess: readonly CapabilityRuntimeAccess[], capabilities: readonly MaterializedMcpCapability[]): CapabilityRuntimeAccess[];
export declare function resolveRunnerMcpProjection(agentEngine: AgentEngine, input: {
    runtimeAccess: readonly CapabilityRuntimeAccess[];
    mcpSourceRecords: readonly MaterializedMcpServer[];
}): ResolvedRunnerMcpProjection;
export declare function sandboxAllowedNetworkHostsFromRuntimeAccess(runtimeAccess: readonly CapabilityRuntimeAccess[]): string[];
export declare function databaseNetworkHostFromUrl(value: string | undefined): string | undefined;
export declare function loopbackAuthorityFromUrl(value: string | undefined): string | undefined;
export declare function projectSandboxRuntimeModelGatewayEnv(env: Record<string, string> | undefined): SandboxRuntimeModelGatewayProjection;
