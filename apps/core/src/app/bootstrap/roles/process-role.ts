/**
 * Process role: which fleet service this runtime process behaves as. One
 * codebase/image runs as differentiated services by reading the deployment-owned
 * env var {@link PROCESS_ROLE_ENV_VAR} once at boot (NOT settings.yaml — the
 * deployment lane, not desired state, owns this). The workstation default is
 * `all`, which behaves exactly as the single-process runtime always has.
 *
 *  - `all`         single process doing everything (workstation default).
 *  - `control`     control plane only: control API + settings writes, no
 *                  live/job execution and no provider inbound.
 *  - `live-worker` live admission/execution + provider inbound, ops-only API,
 *                  no scheduler/job claiming and no bake queue.
 *  - `job-worker`  scheduler/job execution + bakes, ops-only API, no live
 *                  admission and no provider inbound.
 */
export type ProcessRole = 'all' | 'control' | 'live-worker' | 'job-worker';

/** Deployment-owned env var that selects the process role. */
export const PROCESS_ROLE_ENV_VAR = 'GANTRY_PROCESS_ROLE';

/** Workstation default; behaves exactly as the historical single process. */
export const DEFAULT_PROCESS_ROLE: ProcessRole = 'all';

/** Every valid role value, in declaration order. */
export const PROCESS_ROLES: readonly ProcessRole[] = [
  'all',
  'control',
  'live-worker',
  'job-worker',
];
