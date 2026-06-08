import fs from 'fs';
import path from 'path';

import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import {
  archiveIpcErrorFile,
  claimIpcFile,
  isPendingIpcJsonFile,
  isTrustedDirectory,
} from './ipc-filesystem.js';
import {
  getIpcResponseSigningPrivateKey,
  isBrowserIpcAuthorized,
} from './ipc-auth.js';
import { parseBrowserIpcRequest } from './ipc-parsing.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { canProcessIpcFile } from './ipc-rate-limit.js';

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
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): void {
  const { ipcBaseDir, sourceAgentFolder, browserRequestsDir, deps, logger } =
    input;
  try {
    if (isTrustedDirectory(browserRequestsDir)) {
      const browserFiles = fs
        .readdirSync(browserRequestsDir)
        .filter(isPendingIpcJsonFile);
      for (const file of browserFiles) {
        processOneBrowserRequest({
          ipcBaseDir,
          sourceAgentFolder,
          browserRequestsDir,
          file,
          deps,
          logger,
        });
      }
    } else if (fs.existsSync(browserRequestsDir)) {
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
  file: string;
  deps: IpcDeps;
  logger: IpcBrowserRequestLogger;
}): void {
  const {
    ipcBaseDir,
    sourceAgentFolder,
    browserRequestsDir,
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
    claimedPath = claimIpcFile(filePath);
    const rawRequest = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
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
        fs.unlinkSync(claimedPath);
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
        archiveIpcErrorFile(ipcBaseDir, sourceAgentFolder, file, claimedPath);
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
    archiveIpcErrorFile(ipcBaseDir, sourceAgentFolder, file, claimedPath);
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
