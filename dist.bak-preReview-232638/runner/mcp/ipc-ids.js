import { randomUUID } from 'crypto';
import { nowMs } from '../../shared/time/datetime.js';
export function makeIpcId(prefix) {
    return `${prefix}-${nowMs()}-${randomUUID()}`;
}
export function makeIpcJsonFilename() {
    return `${nowMs()}-${randomUUID()}.json`;
}
