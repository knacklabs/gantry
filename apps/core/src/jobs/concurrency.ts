const activeParallelRunsByGroupScope = new Map<string, number>();

function acquireParallelRunSlot(groupScope: string): () => void {
  const current = activeParallelRunsByGroupScope.get(groupScope) || 0;
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

export function acquireRunSlot(groupScope: string): () => void {
  return acquireParallelRunSlot(groupScope);
}

export function resetSchedulerRunSlots(): void {
  activeParallelRunsByGroupScope.clear();
}
