import { MemoryIpcAction } from '@gantry/contracts';
import { formatDuration } from '../shared/human-format.js';

export function getMemoryActionTimeoutMs(action: MemoryIpcAction): number {
  return action === 'memory_consolidate' ||
    action === 'memory_dream' ||
    action === 'continuity_summary' ||
    action === 'brain_query'
    ? 60_000
    : 15_000;
}

export function formatMemoryTimeoutError(timeoutMs: number): string {
  return `Timed out waiting for memory service response (${formatDuration(timeoutMs)})`;
}
