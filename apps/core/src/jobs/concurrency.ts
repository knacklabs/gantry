const activeParallelRunsByGroupScope = new Map<string, number>();

const DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP = 1;
const RUN_SLOT_RETRY_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryAcquireParallelRunSlot(
  groupScope: string,
  maxParallelRuns: number,
): (() => void) | null {
  const current = activeParallelRunsByGroupScope.get(groupScope) || 0;
  if (current >= maxParallelRuns) return null;
  activeParallelRunsByGroupScope.set(groupScope, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = activeParallelRunsByGroupScope.get(groupScope) || 0;
    if (active <= 1) {
      activeParallelRunsByGroupScope.delete(groupScope);
      return;
    }
    activeParallelRunsByGroupScope.set(groupScope, active - 1);
  };
}

export async function acquireRunSlot(
  groupScope: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
): Promise<() => void> {
  const normalizedMaxParallelRuns = Math.max(1, Math.floor(maxParallelRuns));
  for (;;) {
    const release = tryAcquireParallelRunSlot(
      groupScope,
      normalizedMaxParallelRuns,
    );
    if (release) return release;
    await delay(RUN_SLOT_RETRY_DELAY_MS);
  }
}

export function resetSchedulerRunSlots(): void {
  activeParallelRunsByGroupScope.clear();
}
