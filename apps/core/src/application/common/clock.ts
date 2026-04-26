import type { IsoTimestamp } from '../../shared/time/primitives.js';

export interface Clock {
  now(): IsoTimestamp;
}

export class SystemClock implements Clock {
  now(): IsoTimestamp {
    return new Date().toISOString() as IsoTimestamp;
  }
}
