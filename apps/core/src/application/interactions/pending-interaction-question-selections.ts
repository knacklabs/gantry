export const QUESTION_SELECTIONS_PAYLOAD_KEY = 'questionSelections';

export function questionSelectionsFromPayload(
  payload: Record<string, unknown> | undefined,
): Map<number, Set<number>> {
  const selections = new Map<number, Set<number>>();
  const raw = payload?.[QUESTION_SELECTIONS_PAYLOAD_KEY];
  if (!Array.isArray(raw)) return selections;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const questionIndex =
      typeof record.questionIndex === 'number' &&
      Number.isInteger(record.questionIndex)
        ? record.questionIndex
        : null;
    if (questionIndex === null) continue;
    const optionIndexes = Array.isArray(record.optionIndexes)
      ? record.optionIndexes.filter((value): value is number =>
          Number.isInteger(value),
        )
      : [];
    selections.set(questionIndex, new Set(optionIndexes.sort((a, b) => a - b)));
  }
  return selections;
}

export function serializeQuestionSelections(
  selections: Map<number, Set<number>>,
): Record<string, unknown>[] {
  return [...selections.entries()]
    .sort(([a], [b]) => a - b)
    .map(([questionIndex, optionIndexes]) => ({
      questionIndex,
      optionIndexes: [...optionIndexes].sort((a, b) => a - b),
    }));
}
