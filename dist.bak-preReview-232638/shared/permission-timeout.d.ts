type PermissionTimeoutContext = 'interactive' | 'autonomous';
export declare const NO_PERMISSION_TIMEOUT_MS = 0;
export declare function getPermissionTimeoutMs(context: PermissionTimeoutContext, env?: Record<string, string | undefined>, fallbackEnv?: Record<string, string | undefined>): number;
export declare function resolvePermissionApprovalTimeoutMs(env?: Record<string, string | undefined>, fallbackEnv?: Record<string, string | undefined>): number;
export declare const PERMISSION_APPROVAL_TIMEOUT_MS: number;
export {};
