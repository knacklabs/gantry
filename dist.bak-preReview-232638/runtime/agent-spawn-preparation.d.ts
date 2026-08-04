import type { ChildProcess } from 'node:child_process';
import type { ConversationRoute } from '../domain/types.js';
import type { AgentRepository } from '../domain/ports/repositories.js';
import type { AgentRuntime } from '../shared/agent-runtime.js';
import { createRunnerHostStartupTiming } from './agent-spawn-startup-timing.js';
import type { AgentInput, AgentOutput, RunAgentOptions } from './agent-spawn-types.js';
export { registerWorkerPermissionRunRestriction } from './agent-spawn-permission-run-restriction.js';
type HostStartupTiming = ReturnType<typeof createRunnerHostStartupTiming>;
export type AgentSpawnPreparation = {
    kind: 'inline';
    output: AgentOutput;
} | {
    kind: 'worker';
    agentRuntime: AgentRuntime;
    startTime: number;
    hostStartup: HostStartupTiming;
    groupDir: string;
    processName: string;
};
export declare function prepareAgentSpawn(input: {
    group: ConversationRoute;
    agentInput: AgentInput;
    agentRuntime: AgentRuntime;
    onProcess: (proc: ChildProcess, runHandle: string) => void;
    onOutput: ((output: AgentOutput) => Promise<void>) | undefined;
    options: RunAgentOptions;
    warn: (context: Record<string, unknown>, message: string) => void;
}): Promise<AgentSpawnPreparation>;
export declare function prepareWorkerAuthorityProjection(input: {
    agentInput: AgentInput;
    accessPreset?: 'full' | 'locked';
    delegates: readonly string[];
    getConversationBoundAgentIds: () => ReadonlySet<string>;
    personasByAgentId: Readonly<Record<string, string | undefined>>;
    workspaceFolder: string;
    options?: RunAgentOptions;
    getAgentRepository: () => AgentRepository;
    warn: (context: Record<string, unknown>, message: string) => void;
}): Promise<{
    accessPreset: "full" | "locked";
    hideAuthorityTools: boolean;
    callableAgentManifest: import("../shared/callable-agent-manifest.js").CallableAgentToolManifestEntry[];
}>;
