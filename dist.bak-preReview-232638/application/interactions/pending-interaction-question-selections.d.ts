export declare function questionSelectionsFromPayload(payload: Record<string, unknown> | undefined): Map<number, Set<number>>;
export declare function serializeQuestionSelections(selections: Map<number, Set<number>>): Array<{
    questionIndex: number;
    optionIndexes: number[];
}>;
