import path from 'path';
import { interactionInFlightKey } from './ipc-interaction-processing.js';
import { parseRichInteractionIpcRequest } from './ipc-parsing.js';
import { processRichInteractionIpc } from './ipc-rich-interaction-processing.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';
import { resolveRunnerIpcRoute } from './ipc-route-authorization.js';
const RICH_INTERACTION_LANE = 'rich-interactions';
export function processRichInteractionRequestDirectory(input) {
    const { sourceAgentFolder, runnerControlPort, logger } = input;
    const richInteractionRequestsDir = runnerControlPort.requestDir(sourceAgentFolder, RICH_INTERACTION_LANE);
    try {
        if (input.shouldProcessRequestLane(sourceAgentFolder, RICH_INTERACTION_LANE) &&
            runnerControlPort.isTrustedRequestDir(sourceAgentFolder, RICH_INTERACTION_LANE)) {
            processRichInteractionFiles(input);
        }
        else if (input.processScope === 'all' &&
            runnerControlPort.requestDirExists(sourceAgentFolder, RICH_INTERACTION_LANE)) {
            logger.warn({ sourceAgentFolder, richInteractionRequestsDir }, 'Ignoring untrusted rich interaction IPC requests directory');
        }
    }
    catch (err) {
        logger.error({ err, sourceAgentFolder }, 'Error reading rich interaction IPC requests directory');
    }
}
function processRichInteractionFiles(input) {
    const { sourceAgentFolder, runnerControlPort } = input;
    const richInteractionFiles = runnerControlPort.listPendingRequests(sourceAgentFolder, RICH_INTERACTION_LANE);
    for (const file of richInteractionFiles) {
        processRichInteractionFile(input, file);
    }
}
function processRichInteractionFile(input, file) {
    const { sourceAgentFolder, runnerControlPort, logger } = input;
    let claimedPath = path.join(input.runnerControlPort.requestDir(sourceAgentFolder, RICH_INTERACTION_LANE), file);
    try {
        if (!canProcessIpcFile(sourceAgentFolder, 'rich-interaction')) {
            throw new Error('Rich interaction IPC rate limit exceeded');
        }
        const claimed = runnerControlPort.claimRequest(sourceAgentFolder, RICH_INTERACTION_LANE, file);
        claimedPath = claimed.claimedPath;
        const request = parseRichInteractionIpcRequest(claimed.raw, sourceAgentFolder);
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
    }
    catch (err) {
        logger.error({ file, sourceAgentFolder, err }, 'Error processing rich interaction IPC request');
        runnerControlPort.archiveFailedRequest(sourceAgentFolder, file, claimedPath);
    }
}
