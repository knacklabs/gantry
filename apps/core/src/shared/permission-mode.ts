export type PermissionMode = 'ask' | 'auto' | 'auto_strict';

export const AUTO_PERMISSION_CLASSIFIER_WAIT_MS = 20_000;
export const AUTONOMOUS_JOB_HOST_DECISION_WAIT_MS = 45_000;

export function resolveAutonomousHostDecisionWaitMs(input: {
  isScheduledJob: boolean;
  permissionMode?: PermissionMode;
}): number {
  if (input.isScheduledJob) return AUTONOMOUS_JOB_HOST_DECISION_WAIT_MS;
  return input.permissionMode === 'auto' ||
    input.permissionMode === 'auto_strict'
    ? AUTO_PERMISSION_CLASSIFIER_WAIT_MS
    : 0;
}

export function resolveEffectivePermissionMode(
  conversationMode?: PermissionMode,
  agentMode?: PermissionMode,
): PermissionMode {
  return conversationMode ?? agentMode ?? 'ask';
}
