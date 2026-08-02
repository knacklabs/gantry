import type { ChildProcess } from 'node:child_process';
import type { ConversationRoute } from '../domain/types.js';
import type { HostnameLookup } from '../domain/network/public-address-policy.js';
import { type MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import { resolveSpawnModel } from './agent-spawn-model-resolution.js';
import type { AgentInput, AgentOutput, RunAgentOptions } from './agent-spawn-types.js';
import { type ContinuationRunnerControlPort } from './group-queue-types.js';
import type { RunnerControlContinuationInput } from './runner-control-port.js';
export declare const INLINE_AGENT_LOOP_NOT_AVAILABLE = "INLINE_AGENT_LOOP_NOT_AVAILABLE";
export declare const INLINE_JOB_HEARTBEAT_INTERVAL_MS = 15000;
interface InlineControlSubscriber {
    onContinuation(input: RunnerControlContinuationInput): void;
    onClose(): void;
}
export declare class InMemoryInlineRunnerControlPort implements ContinuationRunnerControlPort {
    private readonly subscribers;
    private pendingContinuations;
    private closeRequested;
    subscribe(subscriber: InlineControlSubscriber): () => void;
    writeContinuationInput(input: RunnerControlContinuationInput): void;
    writeCloseSignal(): void;
}
export interface InlineJobActivity {
    beginPermissionRequest(requestId: string, toolName: string): void;
    finishPermissionRequest(requestId: string): void;
}
export interface InlineAgentLoopLaneInput {
    group: ConversationRoute;
    correlationRunId?: string;
    input: AgentInput & {
        compiledSystemPrompt: string;
        permissionMode: PermissionMode;
        disableTools?: boolean;
    };
    signal: AbortSignal;
    controlPort: InMemoryInlineRunnerControlPort;
    resolvedModel: Awaited<ReturnType<typeof resolveSpawnModel>>['resolvedModel'];
    modelCredentialEnv: Readonly<Record<string, string>>;
    mcpServers: readonly MaterializedMcpCapability[];
    mcpHostnameLookup?: HostnameLookup;
    skillRepository?: RunAgentOptions['skillRepository'];
    skillArtifactStore?: RunAgentOptions['skillArtifactStore'];
    skillContext?: RunAgentOptions['skillContext'];
    runtimeDataDir: string;
    maxTurns?: number;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    configuredThinking?: import('../domain/types.js').AgentControlThinking;
    maxOutputTokens?: number;
    jobActivity: InlineJobActivity;
    emitOutput(output: AgentOutput): Promise<void>;
}
export type InlineAgentLoopLane = (input: InlineAgentLoopLaneInput) => Promise<AgentOutput>;
export interface InlineRunAgentOptions extends RunAgentOptions {
    inlineAgentLoopLane?: InlineAgentLoopLane;
}
export declare function configureDefaultInlineAgentLoopLane(lane: InlineAgentLoopLane | undefined): void;
/**
 * Follow-up loop-lane work replaces this seam, not the execution shell.
 * Implementations must observe signal.abort; the run remains active until the
 * lane settles so cancellation cannot leave hidden in-process work behind.
 */
export declare function runInlineAgentLoopLane(input: InlineAgentLoopLaneInput): Promise<AgentOutput>;
export declare function createInlineRunHandle(controller: AbortController, controlPort?: InMemoryInlineRunnerControlPort): ChildProcess;
export declare function runInlineAgent(group: ConversationRoute, input: AgentInput, onProcess: (proc: ChildProcess, runHandle: string) => void, onOutput: ((output: AgentOutput) => Promise<void>) | undefined, options: InlineRunAgentOptions): Promise<AgentOutput>;
export {};
