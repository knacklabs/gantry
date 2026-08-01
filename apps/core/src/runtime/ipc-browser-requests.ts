import path from 'path';

import {
  getIpcResponseSigningPrivateKey,
  browserTurnBinding,
  isBrowserIpcAuthorized,
} from './ipc-auth.js';
import { parseBrowserIpcRequest } from './ipc-parsing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';
import type { RunnerControlPort } from './runner-control-port.js';

interface IpcBrowserRequestLogger {
  warn: (obj: Record<string, unknown>, message: string) => void;
  error: (obj: Record<string, unknown>, message: string) => void;
}

const MAX_IN_FLIGHT_BROWSER_IPC = 4;
let inFlightBrowserIpc = 0;

export function processBrowserRequestDirectory(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  browserRequestsDir: string;
  runnerControlPort: RunnerControlPort;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): void {
  const {
    ipcBaseDir,
    sourceAgentFolder,
    browserRequestsDir,
    runnerControlPort,
    deps,
    logger,
  } = input;
  try {
    if (
      runnerControlPort.isTrustedRequestDir(
        sourceAgentFolder,
        'browser-requests',
      )
    ) {
      const browserFiles = runnerControlPort.listPendingRequests(
        sourceAgentFolder,
        'browser-requests',
      );
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
    } else if (
      runnerControlPort.requestDirExists(sourceAgentFolder, 'browser-requests')
    ) {
      logger.warn(
        { sourceAgentFolder, browserRequestsDir },
        'Ignoring untrusted browser IPC requests directory',
      );
    }
  } catch (err) {
    logger.error(
      { err, sourceAgentFolder },
      'Error reading browser IPC requests directory',
    );
  }
}

function processOneBrowserRequest(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  browserRequestsDir: string;
  runnerControlPort: RunnerControlPort;
  file: string;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): void {
  const {
    ipcBaseDir,
    sourceAgentFolder,
    browserRequestsDir,
    runnerControlPort,
    file,
    deps,
    logger,
  } = input;
  const filePath = path.join(browserRequestsDir, file);
  let claimedPath = filePath;
  let requestId: string | undefined;
  let authThreadId: string | undefined;
  let responseKeyId: string | undefined;
  try {
    const claimed = runnerControlPort.claimRequest(
      sourceAgentFolder,
      'browser-requests',
      file,
    );
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
    if (
      browserIpcAuthorized &&
      !canProcessIpcFile(sourceAgentFolder, 'browser')
    ) {
      throw new Error('Browser IPC rate limit exceeded');
    }
    if (inFlightBrowserIpc >= MAX_IN_FLIGHT_BROWSER_IPC) {
      throw new Error('Browser IPC concurrency limit exceeded');
    }
    // Resolve BEFORE taking an in-flight slot. A refusal here throws
    // synchronously, which would bypass the promise cleanup that releases the
    // slot and leave IPC permanently counted as busy.
    const turn = resolveBrowserTurnForRequest({
      sourceAgentFolder,
      chatJid: request.chatJid,
      threadId: request.threadId,
      turnToken: request.browserTurnToken,
    });
    inFlightBrowserIpc += 1;
    void processBrowserIpcRequest(request, {
      sourceAgentFolder,
      browserProfileName: turn.profileName,
      turnQueueKey: turn.queueKey,
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
        writeBrowserIpcResponse(
          ipcBaseDir,
          sourceAgentFolder,
          {
            requestId: request.requestId,
            ok: response.ok,
            data: response.data,
            error: response.error,
          },
          getIpcResponseSigningPrivateKey(
            sourceAgentFolder,
            request.threadId,
            request.responseKeyId,
          ),
        );
        runnerControlPort.removeClaimedRequest(claimedPath);
      })
      .catch((err) => {
        logger.error(
          { file, sourceAgentFolder, err },
          'Error processing browser IPC request',
        );
        try {
          writeBrowserIpcResponse(
            ipcBaseDir,
            sourceAgentFolder,
            {
              requestId: request.requestId,
              ok: false,
              error: 'Failed to process browser request',
            },
            getIpcResponseSigningPrivateKey(
              sourceAgentFolder,
              request.threadId,
              request.responseKeyId,
            ),
          );
        } catch (writeErr) {
          logger.warn(
            { sourceAgentFolder, requestId: request.requestId, err: writeErr },
            'Failed to write browser IPC error fallback',
          );
        }
        runnerControlPort.archiveFailedRequest(
          sourceAgentFolder,
          file,
          claimedPath,
        );
      })
      .finally(() => {
        inFlightBrowserIpc -= 1;
      });
  } catch (err) {
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
    logger.error(
      { file, sourceAgentFolder, err },
      'Error processing browser IPC request',
    );
    runnerControlPort.archiveFailedRequest(
      sourceAgentFolder,
      file,
      claimedPath,
    );
  }
}

function writeBrowserFailureResponse(input: {
  ipcBaseDir: string;
  sourceAgentFolder: string;
  requestId: string;
  authThreadId?: string;
  responseKeyId?: string;
  logger: IpcBrowserRequestLogger;
}): void {
  const {
    ipcBaseDir,
    sourceAgentFolder,
    requestId,
    authThreadId,
    responseKeyId,
    logger,
  } = input;
  try {
    writeBrowserIpcResponse(
      ipcBaseDir,
      sourceAgentFolder,
      { requestId, ok: false, error: 'Failed to process browser request' },
      getIpcResponseSigningPrivateKey(
        sourceAgentFolder,
        authThreadId,
        responseKeyId,
      ),
    );
  } catch (writeErr) {
    logger.warn(
      { sourceAgentFolder, requestId, err: writeErr },
      'Failed to write browser IPC error fallback',
    );
  }
}

/**
 * Resolves the browser profile for an inbound IPC request by VALIDATING the
 * name the runner was issued, rather than re-deriving it.
 *
 * Re-deriving cannot work at this boundary: the request carries no account (and
 * must not, or a runner could name another conversation's profile), so when two
 * accounts serve one conversation the lookup cannot tell which turn is calling.
 * Routes are also mutable, so a reassignment mid-turn would switch an in-flight
 * runner onto another account's logged-in profile.
 *
 * Matching against what the server actually issued fixes both: the name is fixed
 * at spawn, and a runner is bounded to profiles issued for its own conversation
 * and thread.
 */
export function resolveBrowserTurnForRequest(input: {
  sourceAgentFolder: string;
  chatJid: string;
  threadId?: string | null;
  turnToken?: string;
}): { profileName: string; queueKey: string } {
  const binding = browserTurnBinding({
    turnToken: input.turnToken,
    workspaceKey: input.sourceAgentFolder,
    chatJid: input.chatJid,
    threadId: input.threadId,
  });
  if (binding) return binding;
  // NO fallback. A scope-only selection cannot be safe: browser IPC
  // authorization is refcounted per (workspace, chat, thread), which concurrent
  // provider-account turns share, so a revoked turn's delayed request — or a
  // runner that simply omits the field — would bind to whichever turn is still
  // live and reach another account's authenticated browser. The credential is
  // issued in the central runner env, so every adapter has one.
  throw new Error(
    `Browser IPC refused: no live turn owns this browser credential (${input.chatJid}). The runner must present the token issued to it at spawn.`,
  );
}
