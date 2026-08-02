import type { ProcessRole } from './process-role.js';
/**
 * What a process role is allowed to run. Modelled as data (one record per role)
 * so bootstrap gating reads a flag instead of scattering `role === ...` checks.
 *
 *  - `controlApi`: `'full'` mounts every control route (today's behaviour);
 *    `'ops'` mounts only operational + read-only diagnostic routes (health,
 *    readiness, metrics, status/health/doctor), 404ing admin mutation routes.
 *  - `liveExecution`: admit + run live channel turns and serve interaction
 *    (permission/question) callbacks.
 *  - `jobExecution`: claim and run scheduler jobs (the scheduler loop).
 *  - `providerInbound`: connect channels for inbound messages + interaction
 *    callbacks. When false, channels connect outbound-only.
 *  - `settingsDesiredStateWrites`: accept settings desired-state writes through
 *    the control API.
 *  - `bakeExecution`: run the toolchain bake queue + reaper.
 *  - `workerRegistration`: register a `worker_instances` row + run the worker
 *    capability reconciler (false only for `control`, which executes nothing).
 */
export interface RoleCapabilities {
    controlApi: 'full' | 'ops';
    liveExecution: boolean;
    jobExecution: boolean;
    providerInbound: boolean;
    settingsDesiredStateWrites: boolean;
    bakeExecution: boolean;
    workerRegistration: boolean;
}
/** The frozen capability record for a role. */
export declare function roleCapabilities(role: ProcessRole): RoleCapabilities;
