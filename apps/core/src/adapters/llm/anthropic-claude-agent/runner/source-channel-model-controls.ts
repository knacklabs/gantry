/** Source runs use the approved Haiku route with an explicit output budget. */
export function sourceChannelNativeControls(
  workspaceId: string | undefined,
  maxOutputTokens: number | undefined,
) {
  if (!workspaceId?.trim()) return;
  if (
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens! < 1 ||
    maxOutputTokens! > 64000
  )
    throw new Error(
      'Source answer requires a valid bounded output token limit',
    );
  return {
    thinking: undefined,
    effort: undefined,
    description: 'source Haiku: thinking and effort omitted',
    env: {
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
      MAX_THINKING_TOKENS: '0',
    },
  };
}
