import type { Job } from '../domain/types.js';
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
  const merged = existing
    ? {
        ...systemJob,
        name: existing.name,
        schedule_value: existing.schedule_value,
        silent: existing.silent,
      }
    : systemJob;
  return merged as unknown as UpsertJobInput;
}
