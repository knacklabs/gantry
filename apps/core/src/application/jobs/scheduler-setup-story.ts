import type {
  Job,
  JobSetupBlocker,
  JobSetupState,
  MessageActionAffordance,
} from '../../domain/types.js';
import {
  formatJobSetupAction,
  setupBlockerLabel,
} from '../../shared/job-setup-labels.js';

export type SchedulerSetupStorySource =
  | 'preflight_setup'
  | 'final_setup'
  | 'permission_denied'
  | 'permission_timeout'
  | 'transient_permission'
  | 'partial_recovery';

export function formatSchedulerSetupStory(input: {
  job: Pick<Job, 'name'>;
  setupState: JobSetupState;
  primaryBlocker?: JobSetupBlocker;
  source?: SchedulerSetupStorySource;
  runId?: string | null;
}): string {
  const source = input.source ?? 'preflight_setup';
  const primaryBlocker = input.primaryBlocker ?? input.setupState.blockers[0];
  const primaryLabel = setupBlockerLabel(
    primaryBlocker,
    input.setupState.state,
  );
  const status =
    source === 'transient_permission'
      ? `This run finished, but future runs still need ${primaryLabel}.`
      : source === 'partial_recovery'
        ? 'Setup is still incomplete, so this job remains paused.'
        : source === 'permission_denied' || source === 'permission_timeout'
          ? `This job paused because it couldn't use ${primaryLabel}.`
          : "This job hasn't started because setup is incomplete.";
  const blockerLines = input.setupState.blockers.map(
    (blocker) => `- ${setupBlockerLabel(blocker, input.setupState.state)}`,
  );
  return [
    `**🛠️ Setup needed** · ${input.job.name}`,
    status,
    'Needed:',
    ...blockerLines,
    formatJobSetupAction(primaryBlocker?.action, primaryBlocker),
  ].join('\n');
}

// CARDFIX-1: a pause story is never delivered action-less. Retry-and-ask
// resumes the job for one asking run (0134: nothing durable); Pause is real.
export function setupStoryActionAffordances(input: {
  job: Pick<Job, 'id' | 'name'>;
  setupState: JobSetupState;
  source?: SchedulerSetupStorySource;
}): MessageActionAffordance[] {
  const toolOnly =
    input.setupState.blockers.length > 0 &&
    input.setupState.blockers.every((blocker) => blocker.type === 'tool');
  const retryLabel =
    toolOnly &&
    (input.source === 'permission_denied' ||
      input.source === 'permission_timeout')
      ? 'Allow once for this run'
      : 'Retry setup check';
  return [
    ...(toolOnly
      ? [
          {
            kind: 'scheduler_retry_ask' as const,
            label: retryLabel,
            jobId: input.job.id,
          },
        ]
      : []),
    {
      kind: 'scheduler_pause_job' as const,
      label: 'Pause job',
      jobId: input.job.id,
    },
  ];
}
