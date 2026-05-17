export function forceBackgroundNativeAgentInput(
  toolName: string,
  input: unknown,
): Record<string, unknown> {
  if (toolName !== 'Agent' && toolName !== 'Task') {
    return input !== null && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { run_in_background: true };
  }
  return { ...(input as Record<string, unknown>), run_in_background: true };
}
