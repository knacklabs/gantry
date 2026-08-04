import type { IsoTimestamp } from '../../shared/time/primitives.js';
export interface Clock {
    now(): IsoTimestamp;
}
