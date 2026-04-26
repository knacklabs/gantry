import type {
  JobUpsertInput,
  OpsRepository,
} from '../../domain/repositories/ops-repo.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';

export class CreateJobUseCase {
  constructor(
    private readonly deps: {
      ops: OpsRepository;
      scheduler: SchedulerCoordinationPort;
    },
  ) {}

  async execute(input: { job: JobUpsertInput }) {
    const result = await this.deps.ops.upsertJob(input.job);
    this.deps.scheduler.requestSchedulerSync(input.job.id);
    return { jobId: input.job.id, created: result.created };
  }
}
