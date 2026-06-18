const FOLLOWUP_QUESTION_LINE_PATTERN =
  /^(?:quick\s+)?(?:question|next(?:\s+(?:up|question))?|which|what|who|where|when|how|would|should|could|can|do|does|did|is|are|will|shall)\b/i;

function stripLeadingListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim();
}

export function isLikelyFollowupQuestion(text: string | null): boolean {
  const normalized = text?.trim();
  if (!normalized) return false;

  return normalized
    .split(/\r?\n/)
    .map((line) => stripLeadingListMarker(line))
    .filter(Boolean)
    .slice(-6)
    .some(
      (line) =>
        /[?\uFF1F]/.test(line) || FOLLOWUP_QUESTION_LINE_PATTERN.test(line),
    );
}
