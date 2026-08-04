export function forceBackgroundNativeAgentInput(toolName, input) {
    if (toolName !== 'Agent') {
        return input !== null && typeof input === 'object' && !Array.isArray(input)
            ? input
            : {};
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        return { run_in_background: true };
    }
    return { ...input, run_in_background: true };
}
