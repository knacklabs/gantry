import type { ExecutionProviderId } from './sessions.js';

// provider_sessions.context_high_water_mark uses PostgreSQL's integer type.
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export class ProviderSessionMeasurementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderSessionMeasurementError';
  }
}

export type RetiredProviderSessionReference = Readonly<{
  providerSessionId: string;
  externalSessionId: string;
  executionProviderId: ExecutionProviderId;
}>;

export function normalizeProviderSessionContextHighWaterMark(
  value: number,
): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProviderSessionMeasurementError(
      'Provider session context high-water mark must be a non-negative integer',
    );
  }
  return Math.min(value, POSTGRES_INTEGER_MAX);
}
