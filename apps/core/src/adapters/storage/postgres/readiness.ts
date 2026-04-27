import type { StorageCapabilities } from './storage-service.js';

export interface PostgresStorageReadinessFailure {
  summary: string;
  details: string[];
}

export function evaluatePostgresStorageCapabilities(
  capabilities: StorageCapabilities,
): PostgresStorageReadinessFailure | null {
  const details: string[] = [];
  if (!capabilities.vectorSearch) {
    details.push(
      capabilities.vectorReason || 'pgvector extension is required.',
    );
  }
  if (!capabilities.textSearch) {
    details.push(
      capabilities.textSearchReason ||
        'pg_trgm or equivalent text-search extension support is required.',
    );
  }
  if (!capabilities.jobQueue) {
    details.push(capabilities.jobQueueReason || 'pg-boss schema is required.');
  }
  if (details.length === 0) {
    return null;
  }
  return {
    summary: 'Postgres runtime capabilities are not ready.',
    details,
  };
}
