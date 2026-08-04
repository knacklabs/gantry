import { findModelByRunnerModel, resolveModelSelectionForWorkload, } from '../shared/model-catalog.js';
export function defaultModelStatusSelection(defaultModel) {
    const resolved = defaultModel
        ? resolveModelSelectionForWorkload(defaultModel, 'chat')
        : undefined;
    const model = resolved?.ok
        ? resolved.entry
        : defaultModel
            ? findModelByRunnerModel(defaultModel)
            : undefined;
    return {
        selectionSource: 'chat default',
        modelAlias: resolved?.ok ? resolved.alias : model?.recommendedAlias,
        model,
    };
}
