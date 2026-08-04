import path from 'path';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import { getIpcResponseSigningPrivateKey, isBrowserIpcAuthorized, } from './ipc-auth.js';
import { parseBrowserIpcRequest } from './ipc-parsing.js';
import { processBrowserIpcRequest, writeBrowserIpcResponse, } from './ipc-browser-handler.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';
const MAX_IN_FLIGHT_BROWSER_IPC = 4;
let inFlightBrowserIpc = 0;
export function processBrowserRequestDirectory(input) {
    const { ipcBaseDir, sourceAgentFolder, browserRequestsDir, runnerControlPort, deps, logger, } = input;
    try {
        if (runnerControlPort.isTrustedRequestDir(sourceAgentFolder, 'browser-requests')) {
            const browserFiles = runnerControlPort.listPendingRequests(sourceAgentFolder, 'browser-requests');
            for (const file of browserFiles) {
                processOneBrowserRequest({
                    ipcBaseDir,
                    sourceAgentFolder,
                    browserRequestsDir,
                    runnerControlPort,
                    file,
                    deps,
                    logger,
                });
            }
        }
        else if (runnerControlPort.requestDirExists(sourceAgentFolder, 'browser-requests')) {
            logger.warn({ sourceAgentFolder, browserRequestsDir }, 'Ignoring untrusted browser IPC requests directory');
        }
    }
    catch (err) {
        logger.error({ err, sourceAgentFolder }, 'Error reading browser IPC requests directory');
    }
}
function processOneBrowserRequest(input) {
    const { ipcBaseDir, sourceAgentFolder, browserRequestsDir, runnerControlPort, file, deps, logger, } = input;
    const filePath = path.join(browserRequestsDir, file);
    let claimedPath = filePath;
    let requestId;
    let authThreadId;
    let responseKeyId;
    try {
        const claimed = runnerControlPort.claimRequest(sourceAgentFolder, 'browser-requests', file);
        claimedPath = claimed.claimedPath;
        const rawRequest = claimed.raw;
        const request = parseBrowserIpcRequest(rawRequest, sourceAgentFolder);
        requestId = request.requestId;
        authThreadId = request.threadId;
        responseKeyId = request.responseKeyId;
        const browserIpcAuthorized = isBrowserIpcAuthorized({
            workspaceKey: sourceAgentFolder,
            chatJid: request.chatJid,
            threadId: authThreadId,
        });
        if (browserIpcAuthorized &&
            !canProcessIpcFile(sourceAgentFolder, 'browser')) {
            throw new Error('Browser IPC rate limit exceeded');
        }
        if (inFlightBrowserIpc >= MAX_IN_FLIGHT_BROWSER_IPC) {
            throw new Error('Browser IPC concurrency limit exceeded');
        }
        inFlightBrowserIpc += 1;
        void processBrowserIpcRequest(request, {
            sourceAgentFolder,
            browserProfileName: resolveConversationBrowserProfile({
                workspaceKey: sourceAgentFolder,
                conversationId: request.chatJid,
            }),
            browserIpcAuthorized,
            getFileArtifactStore: deps.getFileArtifactStore,
            callBrowserTool: deps.callBrowserTool,
            publishBrowserJobActivity: deps.publishBrowserJobActivity,
            closeBrowserToolBackends: deps.closeBrowserToolBackends,
            getBrowserUsageSettings: deps.getBrowserUsageSettings,
            timeoutMs: request.timeoutMs,
            deadlineAtMs: request.deadlineAtMs,
        })
            .then((response) => {
            writeBrowserIpcResponse(ipcBaseDir, sourceAgentFolder, {
                requestId: request.requestId,
                ok: response.ok,
                data: response.data,
                error: response.error,
            }, getIpcResponseSigningPrivateKey(sourceAgentFolder, request.threadId, request.responseKeyId));
            runnerControlPort.removeClaimedRequest(claimedPath);
        })
            .catch((err) => {
            logger.error({ file, sourceAgentFolder, err }, 'Error processing browser IPC request');
            try {
                writeBrowserIpcResponse(ipcBaseDir, sourceAgentFolder, {
                    requestId: request.requestId,
                    ok: false,
                    error: 'Failed to process browser request',
                }, getIpcResponseSigningPrivateKey(sourceAgentFolder, request.threadId, request.responseKeyId));
            }
            catch (writeErr) {
                logger.warn({ sourceAgentFolder, requestId: request.requestId, err: writeErr }, 'Failed to write browser IPC error fallback');
            }
            runnerControlPort.archiveFailedRequest(sourceAgentFolder, file, claimedPath);
        })
            .finally(() => {
            inFlightBrowserIpc -= 1;
        });
    }
    catch (err) {
        if (requestId) {
            writeBrowserFailureResponse({
                ipcBaseDir,
                sourceAgentFolder,
                requestId,
                authThreadId,
                responseKeyId,
                logger,
            });
        }
        logger.error({ file, sourceAgentFolder, err }, 'Error processing browser IPC request');
        runnerControlPort.archiveFailedRequest(sourceAgentFolder, file, claimedPath);
    }
}
function writeBrowserFailureResponse(input) {
    const { ipcBaseDir, sourceAgentFolder, requestId, authThreadId, responseKeyId, logger, } = input;
    try {
        writeBrowserIpcResponse(ipcBaseDir, sourceAgentFolder, { requestId, ok: false, error: 'Failed to process browser request' }, getIpcResponseSigningPrivateKey(sourceAgentFolder, authThreadId, responseKeyId));
    }
    catch (writeErr) {
        logger.warn({ sourceAgentFolder, requestId, err: writeErr }, 'Failed to write browser IPC error fallback');
    }
}
