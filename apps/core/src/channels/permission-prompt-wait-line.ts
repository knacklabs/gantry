export function permissionPromptWaitLine(
  waitsForDecision: boolean,
  replyInMinutes: number,
): string {
  return waitsForDecision
    ? 'This job waits for your decision.'
    : `Reply in ${replyInMinutes}m`;
}
