const activeParallelRunsByWorkspaceKey = new Map<string, number>();

const DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP = 1;
const RUN_SLOT_RETRY_DELAY_MS = 100;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryAcquireParallelRunSlot(
  workspaceKey: string,
  maxParallelRuns: number,
): (() => void) | null {
  const current = activeParallelRunsByWorkspaceKey.get(workspaceKey) || 0;
  if (current >= maxParallelRuns) return null;
  activeParallelRunsByWorkspaceKey.set(workspaceKey, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const active = activeParallelRunsByWorkspaceKey.get(workspaceKey) || 0;
    if (active <= 1) {
      activeParallelRunsByWorkspaceKey.delete(workspaceKey);
      return;
    }
    activeParallelRunsByWorkspaceKey.set(workspaceKey, active - 1);
  };
}

export async function acquireRunSlot(
  workspaceKey: string,
  maxParallelRuns = DEFAULT_MAX_PARALLEL_RUNS_PER_GROUP,
): Promise<() => void> {
  const normalizedMaxParallelRuns = Math.max(1, Math.floor(maxParallelRuns));
  for (;;) {
    const release = tryAcquireParallelRunSlot(
      workspaceKey,
      normalizedMaxParallelRuns,
    );
    if (release) return release;
    await delay(RUN_SLOT_RETRY_DELAY_MS);
  }
}

export function resetSchedulerRunSlots(): void {
  activeParallelRunsByWorkspaceKey.clear();
}
