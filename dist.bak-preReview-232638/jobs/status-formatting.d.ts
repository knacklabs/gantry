import type { Job } from '../domain/types.js';
export declare function formatRunStatusMessage(args: {
    job: Job;
    runId: string;
    runShortId?: number | null;
    runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
    summary: string;
    nextRun: string | null;
    retryCount: number;
    pauseReason?: string | null;
    durationMs?: number;
}): string;
export declare function selectJobNotificationSummary(summary: string): string;
