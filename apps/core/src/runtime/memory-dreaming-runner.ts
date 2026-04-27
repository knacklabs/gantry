import { getMemoryMaintenanceQueue } from '../memory/maintenance-queue.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import { AppMemoryService } from '../memory/app-memory-service.js';

const memoryMaintenanceQueue = getMemoryMaintenanceQueue();

export async function runDreamingForGroup(groupFolder: string) {
  const result = await memoryMaintenanceQueue.enqueueAndWait(
    groupFolder,
    async () => {
      await AppMemoryService.getInstance().triggerDreaming({
        appId: DEFAULT_MEMORY_APP_ID,
        agentId: memoryAgentIdForGroupFolder(groupFolder),
        groupId: groupFolder,
        phase: 'all',
      });
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
