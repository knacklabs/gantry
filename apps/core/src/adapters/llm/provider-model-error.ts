import type { ModelCatalogEntry } from '../../shared/model-catalog.js';

const MODEL_NOT_AVAILABLE_CODE = /\bmodel_not_found\b/i;
const RESOURCE_NOT_FOUND_CODE = /\bnot_found_error\b/i;

export function normalizeProviderModelError(input: {
  error: string | undefined;
  modelEntry: ModelCatalogEntry;
}): string | undefined {
  const error = input.error?.trim();
  const modelId = input.modelEntry.modelRoute.providerModelId;
  const mentionsSelectedModel =
    error?.includes(`"${modelId}"`) ||
    error?.includes(`'${modelId}'`) ||
    error?.includes(`\`${modelId}\``);
  const modelUnavailable =
    (mentionsSelectedModel && MODEL_NOT_AVAILABLE_CODE.test(error ?? '')) ||
    (input.modelEntry.modelRoute.id === 'anthropic' &&
      RESOURCE_NOT_FOUND_CODE.test(error ?? ''));
  if (!error || !modelUnavailable) {
    return error;
  }
  return `MODEL_NOT_AVAILABLE: Model alias "${input.modelEntry.recommendedAlias}" resolves to provider model "${input.modelEntry.modelRoute.providerModelId}", which ${input.modelEntry.modelRoute.label} reported as absent.`;
}
