import type {
  Job,
  JobSetupBlocker,
  JobSetupState,
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
