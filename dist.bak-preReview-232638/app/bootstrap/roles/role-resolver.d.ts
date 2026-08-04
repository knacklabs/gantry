import { type ProcessRole } from './process-role.js';
/**
 * Resolve the process role from the deployment env. Missing or empty →
 * {@link DEFAULT_PROCESS_ROLE} (`all`, the workstation default). A recognised
 * value is returned as-is. Anything else THROWS: a wrong-lane deployment env
 * must fail loudly at boot rather than silently degrade to `all` and run the
 * wrong subsystems.
 *
 * Pure over `env` so callers can resolve once in `startGantryRuntime` and thread
 * the result, and so tests can exercise it without mutating `process.env`.
 */
export declare function resolveProcessRole(env: NodeJS.ProcessEnv): ProcessRole;
