export type PermissionMode = 'ask' | 'auto' | 'auto_strict';
export declare const AUTO_PERMISSION_CLASSIFIER_WAIT_MS = 20000;
export declare function resolveEffectivePermissionMode(conversationMode?: PermissionMode, agentMode?: PermissionMode): PermissionMode;
