/** Deployment-owned env var that selects the process role. */
export const PROCESS_ROLE_ENV_VAR = 'GANTRY_PROCESS_ROLE';
/** Workstation default; behaves exactly as the historical single process. */
export const DEFAULT_PROCESS_ROLE = 'all';
/** Every valid role value, in declaration order. */
export const PROCESS_ROLES = [
    'all',
    'control',
    'live-worker',
    'job-worker',
];
