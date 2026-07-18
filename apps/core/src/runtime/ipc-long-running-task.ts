import type { IpcDeps } from './ipc-domain-types.js';
import type { parseTaskIpcData } from './ipc-task-parsing.js';
import type { RunnerControlPort } from './runner-control-port.js';
import { processTaskIpc } from '../jobs/ipc-handler.js';
import { writeTaskIpcResponse } from '../jobs/ipc-shared.js';
import { logger } from '../infrastructure/logging/logger.js';

export const isLongRunningTask = (type: string): boolean =>
  type.startsWith('mcp_') ||
  type === 'scheduler_wait_for_events' ||
  type === 'delegate_task';

export async function processLongRunningTaskIpc(input: {
  data: ReturnType<typeof parseTaskIpcData>;
  sourceAgentFolder: string;
  deps: IpcDeps;
  ipcBaseDir: string;
  file: string;
  claimedPath: string;
  runnerControlPort: RunnerControlPort;
}): Promise<void> {
  try {
    await processTaskIpc(
      input.data,
      input.sourceAgentFolder,
      input.deps,
      input.ipcBaseDir,
    );
    input.runnerControlPort.removeClaimedRequest(input.claimedPath);
  } catch (err) {
    writeTaskIpcResponse(
      input.sourceAgentFolder,
      input.data.taskId,
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      input.data.authThreadId,
      input.data.responseKeyId,
    );
    logger.error(
      { file: input.file, sourceAgentFolder: input.sourceAgentFolder, err },
      'Error processing long-running IPC task',
    );
    input.runnerControlPort.archiveFailedRequest(
      input.sourceAgentFolder,
      input.file,
      input.claimedPath,
    );
  }
}
