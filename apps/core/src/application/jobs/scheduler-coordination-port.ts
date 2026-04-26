export interface SchedulerCoordinationPort {
  requestSchedulerSync(jobId?: string): void;
}
