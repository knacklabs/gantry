import type { Job } from '../domain/types.js';
import { nowIso } from '../shared/time/datetime.js';
import { computeNextJobRun } from './schedule-math.js';
import type { SchedulerDependencies } from './types.js';

type UpsertJobInput = Parameters<
  SchedulerDependencies['opsRepository']['upsertJob']
>[0];

// Restart reconciliation must not clobber operator/agent edits. When a system
// job already exists, carry its operator-editable fields (name, schedule value,
// silent) forward instead of the hardcoded code constants. The runtime still
// owns id/prompt/execution_context/notification_routes/timeout, which are
// re-stamped from code every pass.
export function preserveOperatorSystemJobEdits<
  T extends { name: string; schedule_value: string; silent: boolean },
>(systemJob: T, existing: Job | undefined): UpsertJobInput {
  if (!existing) return systemJob as unknown as UpsertJobInput;
  // next_run must agree with the schedule we're preserving. The running job's
  // next_run already tracks its (possibly operator-edited) schedule, so carry
  // it. If it's absent, recompute from the preserved schedule — never leave a
  // next_run derived from the hardcoded code default beside an edited schedule.
  const next_run =
    existing.next_run ??
    computeNextJobRun(
      {
        schedule_type: existing.schedule_type,
        schedule_value: existing.schedule_value,
      },
      nowIso(),
    );
  return {
    ...systemJob,
    name: existing.name,
    schedule_type: existing.schedule_type,
    schedule_value: existing.schedule_value,
    silent: existing.silent,
    next_run,
  } as unknown as UpsertJobInput;
}
