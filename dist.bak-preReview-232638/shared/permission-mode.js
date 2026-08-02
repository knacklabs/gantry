export const AUTO_PERMISSION_CLASSIFIER_WAIT_MS = 20_000;
export function resolveEffectivePermissionMode(conversationMode, agentMode) {
    return conversationMode ?? agentMode ?? 'ask';
}
