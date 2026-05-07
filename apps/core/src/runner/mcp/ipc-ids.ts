import { randomUUID } from 'crypto';
import { nowMs } from '../../infrastructure/time/datetime.js';

export function makeIpcId(prefix: string): string {
  return `${prefix}-${nowMs()}-${randomUUID()}`;
}

export function makeIpcJsonFilename(): string {
  return `${nowMs()}-${randomUUID()}.json`;
}
