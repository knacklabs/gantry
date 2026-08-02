import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
export declare function structuredOutputError(error: unknown, newSessionId: string): RunnerOutputFrame & {
    structuredOutputValidationFailure: true;
};
export declare function abortedOutput(newSessionId?: string): RunnerOutputFrame;
