import type {
  Job,
  JobSetupBlocker,
  JobSetupState,
} from '../../domain/types.js';
import {
  setupActionLabel,
  setupBlockerLabel,
} from '../../shared/job-setup-labels.js';

export type SchedulerSetupStorySource =
  | 'preflight_setup'
  | 'final_setup'
  | 'permission_denied'
  | 'permission_timeout'
  | 'transient_permission';

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
  const failedAction =
    source === 'permission_denied' || source === 'permission_timeout'
      ? `Use ${primaryLabel}`
      : source === 'transient_permission'
        ? `Keep ${primaryLabel} available for future runs`
        : 'Start the scheduled run';
  const triggeringStep =
    source === 'permission_denied'
      ? 'Permission check during the run'
      : source === 'permission_timeout'
        ? 'Permission approval wait during the run'
        : source === 'transient_permission'
          ? 'Post-run access check'
          : source === 'final_setup'
            ? 'Final setup check before execution'
            : 'Pre-run setup check';
  const outcome =
    source === 'transient_permission'
      ? 'Degraded — this run completed with temporary access; future runs are paused.'
      : source === 'permission_denied' || source === 'permission_timeout'
        ? 'Died — this run stopped before completing.'
        : 'Died — setup was checked before execution; this run did not start.';
  const blockerLines = input.setupState.blockers.map(
    (blocker, index) =>
      `${index + 1}. ${setupBlockerLabel(blocker, input.setupState.state)}`,
  );
  return [
    `**🛠️ Setup needed** · ${input.job.name}`,
    `Failed action: ${failedAction}`,
    `Triggering step: ${triggeringStep}`,
    `Run outcome: ${outcome}`,
    `Blockers (${blockerLines.length}):`,
    ...blockerLines,
    `Action: ${setupActionLabel(primaryBlocker)}`,
  ].join('\n');
}
