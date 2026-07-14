import path from 'path';

import type { IpcDeps } from './ipc-domain-types.js';
import type { ConversationRoute } from '../domain/types.js';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parseRichInteractionIpcRequest } from './ipc-parsing.js';
import { processRichInteractionIpc } from './ipc-rich-interaction-processing.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';
import type { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import { resolveRunnerIpcRoute } from './ipc-route-authorization.js';

const RICH_INTERACTION_LANE = 'rich-interactions';

type RichInteractionDirectoryLogger = {
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
};

export function processRichInteractionRequestDirectory(input: {
  sourceAgentFolder: string;
  processScope: 'all' | 'hinted';
  shouldProcessRequestLane(
    sourceAgentFolder: string,
    lane: typeof RICH_INTERACTION_LANE,
  ): boolean;
  folderTargetJid: Map<string, string>;
  folderTargetJids: Map<string, Set<string>>;
  groupRegistry: Record<string, ConversationRoute>;
  inFlightInteractionIpc: Set<string>;
  maxInFlightInteractionIpc: number;
  runnerControlPort: FilesystemRunnerControlPort;
  deps: IpcDeps;
  ipcBaseDir: string;
  logger: RichInteractionDirectoryLogger;
}): void {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  const richInteractionRequestsDir = runnerControlPort.requestDir(
    sourceAgentFolder,
    RICH_INTERACTION_LANE,
  );
  try {
    if (
      input.shouldProcessRequestLane(
        sourceAgentFolder,
        RICH_INTERACTION_LANE,
      ) &&
      runnerControlPort.isTrustedRequestDir(
        sourceAgentFolder,
        RICH_INTERACTION_LANE,
      )
    ) {
      processRichInteractionFiles(input);
    } else if (
      input.processScope === 'all' &&
      runnerControlPort.requestDirExists(
        sourceAgentFolder,
        RICH_INTERACTION_LANE,
      )
    ) {
      logger.warn(
        { sourceAgentFolder, richInteractionRequestsDir },
        'Ignoring untrusted rich interaction IPC requests directory',
      );
    }
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'Error reading rich interaction IPC requests directory',
    );
  }
}

function processRichInteractionFiles(
  input: Parameters<typeof processRichInteractionRequestDirectory>[0],
): void {
  const { sourceAgentFolder, runnerControlPort } = input;
  const richInteractionFiles = runnerControlPort.listPendingRequests(
    sourceAgentFolder,
    RICH_INTERACTION_LANE,
  );
  for (const file of richInteractionFiles) {
    processRichInteractionFile(input, file);
  }
}

function processRichInteractionFile(
  input: Parameters<typeof processRichInteractionRequestDirectory>[0],
  file: string,
): void {
  const { sourceAgentFolder, runnerControlPort, logger } = input;
  let claimedPath = path.join(
    input.runnerControlPort.requestDir(
      sourceAgentFolder,
      RICH_INTERACTION_LANE,
    ),
    file,
  );
  try {
    if (!canProcessIpcFile(sourceAgentFolder, 'rich-interaction')) {
      throw new Error('Rich interaction IPC rate limit exceeded');
    }
    const claimed = runnerControlPort.claimRequest(
      sourceAgentFolder,
      RICH_INTERACTION_LANE,
      file,
    );
    claimedPath = claimed.claimedPath;
    const request = parseRichInteractionIpcRequest(
      claimed.raw,
      sourceAgentFolder,
    );
    const route = resolveRunnerIpcRoute({
      routes: input.groupRegistry,
      sourceAgentFolder,
      targetJid: request.targetJid,
      threadId: request.threadId,
      providerAccountId: request.providerAccountId,
    });
    request.targetJid = route.targetJid;
    request.providerAccountId = route.providerAccountId;
    if (input.inFlightInteractionIpc.size >= input.maxInFlightInteractionIpc) {
      throw new Error('Too many in-flight interaction IPC requests');
    }
    const inFlightKey = interactionInFlightKey({
      sourceAgentFolder,
      kind: 'rich-interaction',
      threadId: request.threadId,
      requestId: request.requestId,
    });
    if (input.inFlightInteractionIpc.has(inFlightKey)) {
      throw new Error('Rich interaction IPC request already in flight');
    }
    input.inFlightInteractionIpc.add(inFlightKey);
    void processRichInteractionIpc({
      request,
      sourceAgentFolder,
      deps: input.deps,
      ipcBaseDir: input.ipcBaseDir,
      file,
      claimedPath,
      logger,
    }).finally(() => input.inFlightInteractionIpc.delete(inFlightKey));
  } catch (err) {
    logger.error(
      { file, sourceAgentFolder, err },
      'Error processing rich interaction IPC request',
    );
    runnerControlPort.archiveFailedRequest(
      sourceAgentFolder,
      file,
      claimedPath,
    );
  }
}
