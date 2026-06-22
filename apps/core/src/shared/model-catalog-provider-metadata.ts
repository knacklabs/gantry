import type { ModelCatalogEntry } from './model-catalog.js';

export interface ModelProviderAvailability {
  verifiedAt: string;
  evidence: {
    source: 'official_docs' | 'provider_cli' | 'provider_api';
    commandOrUrl: string;
  };
  scope:
    | { kind: 'provider' }
    | { kind: 'regions'; values: readonly string[] }
    | { kind: 'locations'; values: readonly string[] };
}

export interface ModelProviderRouting {
  openrouter?: OpenRouterProviderRouting;
}

export interface OpenRouterProviderRouting {
  only?: readonly string[];
  ignore?: readonly string[];
  order?: readonly string[];
  allowFallbacks?: boolean;
  requireParameters?: boolean;
  dataCollection?: 'allow' | 'deny';
  zdr?: boolean;
  enforceDistillableText?: boolean;
  quantizations?: readonly string[];
  sort?: 'price' | 'throughput' | 'latency';
}

export function validateModelProviderMetadata(entry: ModelCatalogEntry): void {
  validateModelProviderAvailability(entry);
  validateModelProviderRouting(entry);
}

function validateModelProviderAvailability(entry: ModelCatalogEntry): void {
  const availability = entry.providerAvailability;
  if (!availability) return;
  if (!availability.verifiedAt.trim()) {
    throw new Error(
      `Model catalog entry ${entry.id} has empty providerAvailability.verifiedAt.`,
    );
  }
  if (!availability.evidence.commandOrUrl.trim()) {
    throw new Error(
      `Model catalog entry ${entry.id} has empty providerAvailability evidence.`,
    );
  }
  if (
    availability.scope.kind !== 'provider' &&
    availability.scope.values.some((value) => !value.trim())
  ) {
    throw new Error(
      `Model catalog entry ${entry.id} has empty providerAvailability scope value.`,
    );
  }
}

function validateModelProviderRouting(entry: ModelCatalogEntry): void {
  const routing = entry.providerRouting?.openrouter;
  if (!routing) return;
  if (entry.modelRoute.id !== 'openrouter') {
    throw new Error(
      `Model catalog entry ${entry.id} declares OpenRouter provider routing on route ${entry.modelRoute.id}.`,
    );
  }
  const stringLists = [
    ['only', routing.only],
    ['ignore', routing.ignore],
    ['order', routing.order],
    ['quantizations', routing.quantizations],
  ] as const;
  for (const [field, values] of stringLists) {
    if (values?.some((value) => !value.trim())) {
      throw new Error(
        `Model catalog entry ${entry.id} has empty OpenRouter provider.${field} value.`,
      );
    }
  }
  const only = new Set(routing.only?.map((value) => value.toLowerCase()));
  const overlap = routing.ignore?.find((value) =>
    only.has(value.toLowerCase()),
  );
  if (overlap) {
    throw new Error(
      `Model catalog entry ${entry.id} lists OpenRouter provider ${overlap} in both only and ignore.`,
    );
  }
}
