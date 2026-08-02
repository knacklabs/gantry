import type { AgentOutput } from './agent-spawn-types.js';
export declare function providerSessionExternalSessionId(output: Pick<AgentOutput, 'providerSession' | 'newSessionId'>): string | undefined;
export declare function outputWithProviderSession(output: AgentOutput, externalSessionId: string | undefined): AgentOutput;
export declare function runnerResultWithProviderSession(input: {
    status: AgentOutput['status'];
    externalSessionId: string | undefined;
    error?: string;
}): AgentOutput;
