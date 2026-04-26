import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import { ApplicationError } from '../common/application-error.js';
import { assertJobBelongsToApp } from './job-access.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';

export class PauseJobUseCase {
  constructor(
    private readonly deps: {
      ops: OpsRepository;
      scheduler: SchedulerCoordinationPort;
    },
  ) {}

  async execute(input: { appId: string; jobId: string; reason?: string }) {
    const job = await this.deps.ops.getJobById(input.jobId);
    if (!job) throw new ApplicationError('NOT_FOUND', 'Job not found');
    assertJobBelongsToApp(job, input.appId);
    const reason = input.reason?.trim() || 'Paused by SDK';
    await this.deps.ops.updateJob(job.id, {
      status: 'paused',
      pause_reason: reason,
      next_run: null,
    });
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { paused: true };
  }
}
