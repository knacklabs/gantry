import { MemoryIpcAction } from '@myclaw/contracts';

export function getMemoryActionTimeoutMs(action: MemoryIpcAction): number {
  return action === 'memory_consolidate' || action === 'memory_dream'
    ? 60_000
    : 15_000;
}

export function formatMemoryTimeoutError(timeoutMs: number): string {
  return `Timed out waiting for memory service response (${timeoutMs}ms)`;
}
