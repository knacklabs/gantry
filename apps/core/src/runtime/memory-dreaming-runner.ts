import { getMemoryMaintenanceQueue } from '../memory/maintenance-queue.js';
import { MemoryService } from '../memory/memory-service.js';

const memoryMaintenanceQueue = getMemoryMaintenanceQueue();

export async function runDreamingForGroup(groupFolder: string) {
  const result = await memoryMaintenanceQueue.enqueueAndWait(
    groupFolder,
    async () => {
      await MemoryService.getInstance().runDreamingSweep(groupFolder);
    },
    `dream:${groupFolder}`,
  );
  if (!result.queued) {
    if (result.reason === 'full')
      throw new Error('memory maintenance queue full');
    if (result.reason === 'invalid')
      throw new Error('invalid memory maintenance group');
  }
  return {
    queued: result.queued,
    pending: memoryMaintenanceQueue.getPendingCount(),
    deduped: result.deduped,
    reason: result.reason,
  };
}
