import { type AgentEngine } from '../shared/agent-engine.js';
import { type AgentRuntime } from '../shared/agent-runtime.js';
import type { RunnerSandboxProviderId } from '../shared/runner-sandbox-provider.js';
import type { ModelCatalogEntry } from '../shared/model-catalog.js';
import type { AgentInput } from './agent-spawn-types.js';
export declare function validateAgentPreSpawnAdmission(input: {
    agentInput: AgentInput;
    agentEngine: AgentEngine;
    agentRuntime?: AgentRuntime;
    modelEntry?: ModelCatalogEntry;
    stdioMcpSourceIds?: readonly string[];
    sandboxProvider: RunnerSandboxProviderId | undefined;
    securityEnv: NodeJS.ProcessEnv;
}): string | null;
