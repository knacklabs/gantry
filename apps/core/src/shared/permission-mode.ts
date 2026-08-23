export type PermissionMode = 'ask' | 'auto' | 'auto_strict';

export function resolveEffectivePermissionMode(
  conversationMode?: PermissionMode,
  agentMode?: PermissionMode,
): PermissionMode {
  return conversationMode ?? agentMode ?? 'ask';
}
