import type { ExecutionProviderId } from './sessions.js';

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

export function assertProviderSessionContextHighWaterMark(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new ProviderSessionMeasurementError(
      'Provider session context high-water mark must be a non-negative integer',
    );
  }
}
