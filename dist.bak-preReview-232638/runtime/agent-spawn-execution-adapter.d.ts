import type { AgentOutput, RunAgentOptions } from './agent-spawn-types.js';
type ExecutionAdapter = NonNullable<RunAgentOptions['executionAdapter']>;
export declare function resolveSpawnExecutionAdapter(executionProviderId: string, options: RunAgentOptions | undefined): {
    ok: true;
    executionAdapter: ExecutionAdapter;
} | {
    ok: false;
    output: AgentOutput;
};
export {};
