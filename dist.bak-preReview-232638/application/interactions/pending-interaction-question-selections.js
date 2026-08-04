export function questionSelectionsFromPayload(payload) {
    const selections = new Map();
    const envelope = payload?.questionRecoveryEnvelope;
    const raw = envelope && typeof envelope === 'object' && !Array.isArray(envelope)
        ? envelope.selections
        : null;
    if (!Array.isArray(raw))
        return selections;
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            continue;
        const record = item;
        const questionIndex = typeof record.questionIndex === 'number' &&
            Number.isInteger(record.questionIndex)
            ? record.questionIndex
            : null;
        if (questionIndex === null)
            continue;
        const optionIndexes = Array.isArray(record.optionIndexes)
            ? record.optionIndexes.filter((value) => Number.isInteger(value))
            : [];
        selections.set(questionIndex, new Set(optionIndexes.sort((a, b) => a - b)));
    }
    return selections;
}
export function serializeQuestionSelections(selections) {
    return [...selections.entries()]
        .sort(([a], [b]) => a - b)
        .map(([questionIndex, optionIndexes]) => ({
        questionIndex,
        optionIndexes: [...optionIndexes].sort((a, b) => a - b),
    }));
}
