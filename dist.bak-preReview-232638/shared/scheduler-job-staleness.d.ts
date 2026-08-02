export type SchedulerJobStaleness = 'missed_window';
type SchedulerStalenessJob = {
    last_run: string | null;
    next_run: string | null;
    schedule_type: string;
    status: string;
};
export declare function schedulerJobStaleness(job: SchedulerStalenessJob, nowMs: number): SchedulerJobStaleness | null;
export declare function staleOnceRequeueBucket(job: SchedulerStalenessJob, nowMs: number, throttleMs: number): number | null;
export {};
