import { processTaskIpc } from '../jobs/ipc-handler.js';
import { writeTaskIpcResponse } from '../jobs/ipc-shared.js';
import { logger } from '../infrastructure/logging/logger.js';
export const isLongRunningTask = (type) => type.startsWith('mcp_') ||
    type === 'scheduler_wait_for_events' ||
    type === 'delegate_task';
export async function processLongRunningTaskIpc(input) {
    try {
        await processTaskIpc(input.data, input.sourceAgentFolder, input.deps, input.ipcBaseDir);
        input.runnerControlPort.removeClaimedRequest(input.claimedPath);
    }
    catch (err) {
        writeTaskIpcResponse(input.sourceAgentFolder, input.data.taskId, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        }, input.data.authThreadId, input.data.responseKeyId);
        logger.error({ file: input.file, sourceAgentFolder: input.sourceAgentFolder, err }, 'Error processing long-running IPC task');
        input.runnerControlPort.archiveFailedRequest(input.sourceAgentFolder, input.file, input.claimedPath);
    }
}
