import type { ModelCatalogEntry } from './model-catalog.js';
import { sourceChatModelAllowed } from './source-chat-model-policy.js';

/** Server-created private admission state. Never accepted from the public request. */
export interface SourceModelSnapshot {
  version: 1;
  alias: string;
  entry: ModelCatalogEntry;
}
export function createSourceModelSnapshot(
  alias: string,
  entry: ModelCatalogEntry,
): SourceModelSnapshot {
  return structuredClone({ version: 1, alias, entry });
}
export function requireSourceModelSnapshot(
  snapshot: SourceModelSnapshot | undefined,
): SourceModelSnapshot {
  if (
    !snapshot ||
    snapshot.version !== 1 ||
    !snapshot.alias ||
    !snapshot.entry?.capabilities ||
    !snapshot.entry.modelRoute?.id ||
    !Array.isArray(snapshot.entry.supportedWorkloads) ||
    !sourceChatModelAllowed(snapshot.entry)
  )
    throw new Error(
      'Source answer model snapshot unavailable; start a new attempt',
    );
  return snapshot;
}
export function sourceModelProfile(value: SourceModelSnapshot) {
  const snapshot = requireSourceModelSnapshot(value);
  const entry = snapshot.entry;
  return {
    alias: snapshot.alias,
    runnerModel: entry.runnerModel,
    responseFamily: entry.responseFamily,
    modelRoute: entry.modelRoute.id,
    modelRouteLabel: entry.modelRoute.label,
    displayName: entry.displayName,
    sourceModelSnapshot: snapshot,
  };
}
