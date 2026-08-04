import { type AgentEngine } from '../shared/agent-engine.js';
import type { RuntimeSecurityEnv } from '../shared/security-posture.js';
import type { RunnerSandboxProviderId } from '../shared/runner-sandbox-provider.js';
export declare function requestsShellAuthority(toolPolicyRules: readonly string[] | undefined): boolean;
export declare function requestsFilesystemAuthority(toolPolicyRules: readonly string[] | undefined): boolean;
export declare function requestsShellOrFilesystemAuthority(toolPolicyRules: readonly string[] | undefined): boolean;
export interface DeepAgentsShellFilesystemGuardInput {
    engine: AgentEngine;
    toolPolicyRules: readonly string[] | undefined;
    securityEnv: RuntimeSecurityEnv;
    sandboxProvider: RunnerSandboxProviderId | undefined;
}
export declare function deepAgentsShellFilesystemGuard(_input: DeepAgentsShellFilesystemGuardInput): string | null;
export declare function deepAgentsShellToolEnabled(input: DeepAgentsShellFilesystemGuardInput): boolean;
export declare function deepAgentsFilesystemToolsEnabled(input: DeepAgentsShellFilesystemGuardInput): boolean;
