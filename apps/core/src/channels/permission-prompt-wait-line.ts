export function permissionPromptWaitLine(
  waitsForDecision: boolean,
  replyInMinutes: number,
): string {
  return waitsForDecision
    ? 'This request stays open until you decide.'
    : `Reply in ${replyInMinutes}m`;
}
