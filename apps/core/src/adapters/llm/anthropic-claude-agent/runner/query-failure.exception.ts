import type { NormalizedModelUsage } from '../../../../shared/model-catalog.js';

export class QueryFailure extends Error {
  constructor(
    message: string,
    readonly partialUsage?: {
      readonly usage: NormalizedModelUsage;
      readonly usageEventId: string;
    },
  ) {
    super(message);
    this.name = 'QueryFailure';
  }
}
