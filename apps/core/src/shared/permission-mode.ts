export type PermissionMode = 'ask' | 'auto' | 'auto_strict';

/** An unset mode lets the safety judge decide; an explicit setting always wins. */
export function resolveEffectivePermissionMode(
  conversationMode?: PermissionMode,
  agentMode?: PermissionMode,
): PermissionMode {
  return conversationMode ?? agentMode ?? 'auto';
}
