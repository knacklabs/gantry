import type { Job } from '../domain/types.js';
import { handleSystemJob } from './system-jobs.js';
type SystemJobContext = Parameters<typeof handleSystemJob>[1];
type SystemJobLogger = {
    warn: (context: Record<string, unknown>, message: string) => void;
};
/**
 * Runs a system job turn and normalizes the outcome to either a displayable
 * result string or an error message.
 */
export declare function runSystemJobTurn(input: {
    currentJob: Job;
    context: SystemJobContext;
    startedAtMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    logger?: SystemJobLogger;
}): Promise<{
    result: string | null;
    error: string | null;
}>;
export declare function runSystemJobWithDeadline(input: {
    currentJob: Job;
    context: SystemJobContext;
    startedAtMs: number;
    timeoutMs: number;
    signal?: AbortSignal;
    logger?: SystemJobLogger;
}): Promise<unknown>;
export {};
