export interface WarmPoolEligibilityInput {
  /**
   * Spawn-facing provider session handle. `group-agent-runner` sources this from
   * turnContext.externalSessionId when a conversation can resume.
   */
  sessionId?: string | null;
  /** Source-facing provider session handle for callers before spawn input exists. */
  externalSessionId?: string | null;
}

function hasSavedSession(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPoolEligible(input: WarmPoolEligibilityInput): boolean {
  return (
    !hasSavedSession(input.sessionId) &&
    !hasSavedSession(input.externalSessionId)
  );
}
