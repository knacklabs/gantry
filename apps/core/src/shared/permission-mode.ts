export type PermissionMode = 'ask' | 'auto';

export const AUTO_PERMISSION_CLASSIFIER_WAIT_MS = 20_000;

export function resolveEffectivePermissionMode(
  conversationMode?: PermissionMode,
  agentMode?: PermissionMode,
): PermissionMode {
  return conversationMode ?? agentMode ?? 'ask';
}
