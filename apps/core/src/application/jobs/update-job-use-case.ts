import type { Job, JobExecutionMode, JobStatus } from '../../domain/types.js';
import type { OpsRepository } from '../../domain/repositories/ops-repo.js';
import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';
import { assertJobBelongsToApp } from './job-access.js';
import type { SchedulerCoordinationPort } from './scheduler-coordination-port.js';

export interface UpdateJobInput {
  appId: string;
  jobId: string;
  patch?: {
    name?: string;
    prompt?: string;
    executionMode?: JobExecutionMode;
    threadId?: string;
    status?: Extract<JobStatus, 'active' | 'paused'>;
  };
  resume?: boolean;
}

export class UpdateJobUseCase {
  constructor(
    private readonly deps: {
      ops: OpsRepository;
      scheduler: SchedulerCoordinationPort;
      clock: Clock;
    },
  ) {}

  async execute(input: UpdateJobInput): Promise<{ job: Job }> {
    const existing = await this.deps.ops.getJobById(input.jobId);
    if (!existing) throw new ApplicationError('NOT_FOUND', 'Job not found');
    assertJobBelongsToApp(existing, input.appId);
    if (input.resume && input.patch && Object.keys(input.patch).length > 0) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'resume cannot be combined with patch updates',
      );
    }

    const updates: Partial<Job> = {};
    if (input.patch) {
      if (typeof input.patch.name === 'string') {
        updates.name = requireNonEmpty(input.patch.name, 'name');
      }
      if (typeof input.patch.prompt === 'string') {
        updates.prompt = requireNonEmpty(input.patch.prompt, 'prompt');
      }
      if (input.patch.executionMode) {
        updates.execution_mode = input.patch.executionMode;
      }
      if (typeof input.patch.threadId === 'string') {
        updates.thread_id = requireNonEmpty(input.patch.threadId, 'threadId');
      }
      if (input.patch.status === 'active') {
        applyResumeUpdates(existing, updates, this.deps.clock);
      } else if (input.patch.status === 'paused') {
        updates.status = 'paused';
        updates.pause_reason = 'Paused by SDK';
        updates.next_run = null;
      }
    }

    if (input.resume) {
      applyResumeUpdates(existing, updates, this.deps.clock);
    }

    if (Object.keys(updates).length === 0) {
      return { job: existing };
    }

    await this.deps.ops.updateJob(existing.id, updates);
    this.deps.scheduler.requestSchedulerSync(existing.id);
    return { job: { ...existing, ...updates } };
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApplicationError('INVALID_REQUEST', `${field} cannot be empty`);
  }
  return trimmed;
}

function applyResumeUpdates(
  existing: Job,
  updates: Partial<Job>,
  clock: Clock,
): void {
  updates.status = 'active';
  updates.pause_reason = null;
  updates.next_run =
    existing.schedule_type === 'manual'
      ? null
      : existing.schedule_type === 'once' && existing.schedule_value
        ? existing.schedule_value
        : clock.now();
}
