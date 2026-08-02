import type { AgentRunnerInput } from './types.js';
export declare function denyNonPromptableAutonomousRecovery(input: {
    agentInput: AgentRunnerInput;
    getNewSessionId: () => string | undefined;
    recoveryAction: string | undefined;
    recoveryMessage: string;
    toolName: string;
    toolPolicyReason: string;
}): {
    behavior: 'deny';
    message: string;
    interrupt: false;
} | undefined;
