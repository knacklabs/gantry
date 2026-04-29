import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config/index.js';
import { nowMs } from '../infrastructure/time/datetime.js';
import { isPlainObject, toTrimmedString } from '../shared/object.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  processMemoryRequest,
  writeMemoryResponse,
} from '../memory/memory-ipc.js';
import {
  computeIpcAuthToken,
  getIpcResponseSigningPrivateKey,
} from './ipc-auth.js';
import {
  processBrowserIpcRequest,
  writeBrowserIpcResponse,
} from './ipc-browser-handler.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { writeTaskIpcResponse } from '../jobs/ipc-shared.js';
import {
  processPermissionIpcRequest,
  processUserQuestionIpcRequest,
  writePermissionIpcResponse,
  writeUserQuestionIpcResponse,
} from './ipc-interaction-handler.js';
import { processTaskIpc } from '../jobs/ipc-handler.js';
import {
  acquireIpcRootLock,
  archiveIpcErrorFile,
  claimIpcFile,
  ensureGroupIpcLayout,
  hasCompleteTrustedGroupIpcLayout,
  isTrustedDirectory,
  readIpcRootLockDetails,
  recoverStaleIpcRootLock,
} from './ipc-filesystem.js';
import {
  parseBrowserIpcRequest,
  parseIpcMessage,
  parseMemoryIpcRequest,
  parsePermissionIpcRequest,
  parseUserQuestionIpcRequest,
} from './ipc-parsing.js';
import { parseTaskIpcData } from './ipc-task-parsing.js';
import { clearConsumedIpcRequestIds } from './ipc-auth-validation.js';
import type { RegisteredGroup as RuntimeGroupRecord } from '../domain/types.js';

export type { IpcDeps } from './ipc-domain-types.js';
export { processTaskIpc } from '../jobs/ipc-handler.js';
export { validateIpcAuthRequest } from './ipc-auth-validation.js';

let ipcWatcherRunning = false;
let ipcWatcherTimer: ReturnType<typeof setTimeout> | undefined;
let ipcRootLockPath: string | undefined;
const IPC_RATE_LIMIT_WINDOW_MS = 60_000;
const IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW = 300;
const ipcRateLimitState = new Map<
  string,
  { windowStart: number; count: number }
>();

function canProcessIpcFile(sourceGroup: string, kind: string): boolean {
  const now = nowMs();
  const key = `${sourceGroup}:${kind}`;
  const state = ipcRateLimitState.get(key);
  if (!state || now - state.windowStart >= IPC_RATE_LIMIT_WINDOW_MS) {
    ipcRateLimitState.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (state.count >= IPC_RATE_LIMIT_MAX_FILES_PER_WINDOW) {
    return false;
  }
  state.count += 1;
  return true;
}

export function resolveIpcFoldersFromGroups(
  groupRegistry: Record<string, RuntimeGroupRecord>,
): string[] {
  return Array.from(
    new Set(
      Object.values(groupRegistry)
        .map((group) => group.folder)
        .filter((folder): folder is string => isValidGroupFolder(folder)),
    ),
  );
}

export function isTrustedRegisteredIpcFolder(
  ipcBaseDir: string,
  folder: string,
): boolean {
  const groupDir = path.join(ipcBaseDir, folder);
  return !fs.existsSync(groupDir) || isTrustedDirectory(groupDir);
}

function releaseIpcRootLock(): void {
  if (!ipcRootLockPath) return;
  try {
    fs.rmSync(ipcRootLockPath, { force: true });
  } catch (err) {
    logger.warn(
      { err, lockPath: ipcRootLockPath },
      'Failed to release IPC lock',
    );
  } finally {
    ipcRootLockPath = undefined;
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });
  try {
    ipcRootLockPath = acquireIpcRootLock(ipcBaseDir);
  } catch (err) {
    const lockPath = path.join(ipcBaseDir, '.lock');
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code === 'EEXIST') {
      const recoveredLock = recoverStaleIpcRootLock(lockPath);
      if (!recoveredLock.recovered) {
        logger.warn(
          {
            lockPath,
            holderPid: recoveredLock.pid,
            holderStartedAt: recoveredLock.startedAt,
            reason: recoveredLock.recoveryReason,
          },
          'IPC watcher lock already held, skipping start',
        );
        return;
      }
      logger.warn(
        {
          lockPath,
          holderPid: recoveredLock.pid,
          holderStartedAt: recoveredLock.startedAt,
          reason: recoveredLock.recoveryReason,
        },
        'Recovered stale IPC watcher lock; retrying start',
      );
      try {
        ipcRootLockPath = acquireIpcRootLock(ipcBaseDir);
      } catch (retryErr) {
        const retryCode =
          retryErr && typeof retryErr === 'object' && 'code' in retryErr
            ? String((retryErr as { code?: string }).code)
            : '';
        if (retryCode === 'EEXIST') {
          const retryDetails = readIpcRootLockDetails(lockPath);
          logger.warn(
            {
              lockPath,
              holderPid: retryDetails.pid,
              holderStartedAt: retryDetails.startedAt,
              reason: 'reacquire_raced',
            },
            'IPC watcher lock already held, skipping start',
          );
          return;
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }
  ipcWatcherRunning = true;
  const initializedLayoutFolders = new Set<string>();

  const scheduleNextPoll = (): void => {
    if (!ipcWatcherRunning) return;
    ipcWatcherTimer = setTimeout(() => {
      void processIpcFiles();
    }, IPC_POLL_INTERVAL);
  };

  const processIpcFiles = async () => {
    if (!ipcWatcherRunning) return;
    const groupRegistry = deps.registeredGroups();
    const groupFolders = resolveIpcFoldersFromGroups(groupRegistry).filter(
      (folder) => {
        if (isTrustedRegisteredIpcFolder(ipcBaseDir, folder)) return true;
        initializedLayoutFolders.delete(folder);
        logger.warn(
          { sourceGroup: folder },
          'Skipping IPC processing for untrusted registered group directory',
        );
        return false;
      },
    );

    for (const folder of groupFolders) {
      if (
        initializedLayoutFolders.has(folder) &&
        hasCompleteTrustedGroupIpcLayout(ipcBaseDir, folder)
      ) {
        continue;
      }
      try {
        ensureGroupIpcLayout(ipcBaseDir, folder);
        if (hasCompleteTrustedGroupIpcLayout(ipcBaseDir, folder)) {
          initializedLayoutFolders.add(folder);
        } else {
          initializedLayoutFolders.delete(folder);
        }
      } catch (err) {
        initializedLayoutFolders.delete(folder);
        logger.warn(
          { sourceGroup: folder, err },
          'Failed to pre-create IPC layout for registered group',
        );
      }
    }

    // Build folder→isMain lookup from known group records
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(groupRegistry)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const memoryRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'memory-requests',
      );
      const browserRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'browser-requests',
      );
      const permissionRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'permission-requests',
      );
      const userQuestionRequestsDir = path.join(
        ipcBaseDir,
        sourceGroup,
        'user-questions',
      );

      // Process messages from this group's IPC directory
      try {
        if (isTrustedDirectory(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceGroup, 'messages')) {
                throw new Error('IPC message rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawData = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
              const data = parseIpcMessage(rawData, sourceGroup);
              // Authorization: verify this group can send to this chatJid
              const targetGroup = groupRegistry[data.chatJid];
              if (
                isMain ||
                (targetGroup && targetGroup.folder === sourceGroup)
              ) {
                if (data.threadId) {
                  await deps.sendMessage(data.chatJid, data.text, {
                    threadId: data.threadId,
                  });
                } else {
                  await deps.sendMessage(data.chatJid, data.text);
                }
                logger.info(
                  { chatJid: data.chatJid, sourceGroup },
                  'IPC message sent',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              }
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(messagesDir)) {
          logger.warn(
            { sourceGroup, messagesDir },
            'Ignoring untrusted IPC messages directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (isTrustedDirectory(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            let claimedPath = filePath;
            let rawTaskData: unknown;
            try {
              if (!canProcessIpcFile(sourceGroup, 'tasks')) {
                throw new Error('IPC task rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              rawTaskData = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
              const data = parseTaskIpcData(rawTaskData, sourceGroup);
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(claimedPath);
            } catch (err) {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              if (isPlainObject(rawTaskData)) {
                const taskId = toTrimmedString(rawTaskData.taskId, {
                  maxLen: 128,
                });
                writeTaskIpcResponse(sourceGroup, taskId, {
                  ok: false,
                  error: errorMessage,
                });
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(tasksDir)) {
          logger.warn(
            { sourceGroup, tasksDir },
            'Ignoring untrusted IPC tasks directory',
          );
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process memory request/response IPC for this group
      try {
        if (isTrustedDirectory(memoryRequestsDir)) {
          const memoryFiles = fs
            .readdirSync(memoryRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of memoryFiles) {
            const filePath = path.join(memoryRequestsDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceGroup, 'memory')) {
                throw new Error('Memory IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseMemoryIpcRequest(rawRequest, sourceGroup);

              const response = await processMemoryRequest(
                {
                  requestId: request.requestId,
                  action: request.action,
                  payload: request.payload || {},
                  ...(request.context ? { context: request.context } : {}),
                },
                sourceGroup,
                isMain,
              );
              writeMemoryResponse(
                sourceGroup,
                request.requestId,
                response,
                getIpcResponseSigningPrivateKey(
                  sourceGroup,
                  request.context?.threadId,
                ),
              );
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing memory IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(memoryRequestsDir)) {
          logger.warn(
            { sourceGroup, memoryRequestsDir },
            'Ignoring untrusted memory IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading memory IPC requests directory',
        );
      }

      // Process browser request/response IPC for this group
      try {
        if (isTrustedDirectory(browserRequestsDir)) {
          const browserFiles = fs
            .readdirSync(browserRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of browserFiles) {
            const filePath = path.join(browserRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            let authThreadId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceGroup, 'browser')) {
                throw new Error('Browser IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseBrowserIpcRequest(rawRequest, sourceGroup);
              requestId = request.requestId;
              authThreadId = request.threadId;
              const response = await processBrowserIpcRequest(request, {
                sourceGroup,
                isMain,
              });
              writeBrowserIpcResponse(
                ipcBaseDir,
                sourceGroup,
                {
                  requestId,
                  ok: response.ok,
                  data: response.data,
                  error: response.error,
                },
                getIpcResponseSigningPrivateKey(sourceGroup, request.threadId),
                computeIpcAuthToken(sourceGroup, request.threadId),
              );
              fs.unlinkSync(claimedPath);
            } catch (err) {
              if (requestId) {
                try {
                  writeBrowserIpcResponse(
                    ipcBaseDir,
                    sourceGroup,
                    {
                      requestId,
                      ok: false,
                      error: 'Failed to process browser request',
                    },
                    getIpcResponseSigningPrivateKey(sourceGroup, authThreadId),
                    computeIpcAuthToken(sourceGroup, authThreadId),
                  );
                } catch (writeErr) {
                  logger.warn(
                    { sourceGroup, requestId, err: writeErr },
                    'Failed to write browser IPC error fallback',
                  );
                }
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing browser IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(browserRequestsDir)) {
          logger.warn(
            { sourceGroup, browserRequestsDir },
            'Ignoring untrusted browser IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading browser IPC requests directory',
        );
      }

      // Process permission request/response IPC for this group
      try {
        if (isTrustedDirectory(permissionRequestsDir)) {
          const permissionFiles = fs
            .readdirSync(permissionRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of permissionFiles) {
            const filePath = path.join(permissionRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceGroup, 'permission')) {
                throw new Error('Permission IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parsePermissionIpcRequest(
                rawRequest,
                sourceGroup,
              );
              requestId = request.requestId;
              const decision = await processPermissionIpcRequest(request, {
                requestPermissionApproval: deps.requestPermissionApproval,
              });
              writePermissionIpcResponse(
                ipcBaseDir,
                sourceGroup,
                {
                  requestId,
                  approved: decision.approved,
                  decidedBy: decision.decidedBy,
                  reason: decision.reason,
                },
                getIpcResponseSigningPrivateKey(sourceGroup, request.threadId),
              );
              fs.unlinkSync(claimedPath);
            } catch (err) {
              if (requestId) {
                try {
                  writePermissionIpcResponse(
                    ipcBaseDir,
                    sourceGroup,
                    {
                      requestId,
                      approved: false,
                      reason: 'Failed to process permission request',
                    },
                    getIpcResponseSigningPrivateKey(sourceGroup),
                  );
                } catch (writeErr) {
                  logger.warn(
                    { sourceGroup, requestId, err: writeErr },
                    'Failed to write permission IPC denial fallback',
                  );
                }
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing permission IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(permissionRequestsDir)) {
          logger.warn(
            { sourceGroup, permissionRequestsDir },
            'Ignoring untrusted permission IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading permission IPC requests directory',
        );
      }

      // Process AskUserQuestion request/response IPC for this group
      try {
        if (isTrustedDirectory(userQuestionRequestsDir)) {
          const questionFiles = fs
            .readdirSync(userQuestionRequestsDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of questionFiles) {
            const filePath = path.join(userQuestionRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceGroup, 'user-question')) {
                throw new Error('User question IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseUserQuestionIpcRequest(
                rawRequest,
                sourceGroup,
              );
              requestId = request.requestId;
              const response = await processUserQuestionIpcRequest(request, {
                requestUserAnswer: deps.requestUserAnswer,
              });
              writeUserQuestionIpcResponse(
                ipcBaseDir,
                sourceGroup,
                {
                  requestId,
                  answers: response.answers || {},
                  answeredBy: response.answeredBy,
                },
                getIpcResponseSigningPrivateKey(sourceGroup, request.threadId),
              );
              fs.unlinkSync(claimedPath);
            } catch (err) {
              if (requestId) {
                try {
                  writeUserQuestionIpcResponse(
                    ipcBaseDir,
                    sourceGroup,
                    {
                      requestId,
                      answers: {},
                    },
                    getIpcResponseSigningPrivateKey(sourceGroup),
                  );
                } catch (writeErr) {
                  logger.warn(
                    { sourceGroup, requestId, err: writeErr },
                    'Failed to write user question IPC fallback response',
                  );
                }
              }
              logger.error(
                { file, sourceGroup, err },
                'Error processing user question IPC request',
              );
              archiveIpcErrorFile(ipcBaseDir, sourceGroup, file, claimedPath);
            }
          }
        } else if (fs.existsSync(userQuestionRequestsDir)) {
          logger.warn(
            { sourceGroup, userQuestionRequestsDir },
            'Ignoring untrusted user question IPC requests directory',
          );
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading user question IPC requests directory',
        );
      }
    }

    scheduleNextPoll();
  };

  void processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export function stopIpcWatcher(): void {
  if (ipcWatcherTimer) {
    clearTimeout(ipcWatcherTimer);
    ipcWatcherTimer = undefined;
  }
  ipcWatcherRunning = false;
  ipcRateLimitState.clear();
  clearConsumedIpcRequestIds();
  releaseIpcRootLock();
  logger.info('IPC watcher stopped');
}
