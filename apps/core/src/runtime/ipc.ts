import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config/index.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { logger } from '../infrastructure/logging/logger.js';
// prettier-ignore
import { processMemoryRequest, writeMemoryResponse } from '../memory/memory-ipc.js';
// prettier-ignore
import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import type { IpcDeps } from './ipc-domain-types.js';
// prettier-ignore
import { interactionInFlightKey, processPermissionInteractionIpc, processUserQuestionInteractionIpc, writePermissionInteractionFailure, writeUserQuestionInteractionFailure } from './ipc-interaction-processing.js';
import { processTaskIpc } from '../jobs/ipc-handler.js';
// prettier-ignore
import { parseIpcMessage, parseMemoryIpcRequest, parsePermissionIpcRequest, parseUserQuestionIpcRequest } from './ipc-parsing.js';
import { parseTaskIpcData } from './ipc-task-parsing.js';
import {
  isLongRunningTask,
  processLongRunningTaskIpc,
} from './ipc-long-running-task.js';
import { clearConsumedIpcRequestIds } from './ipc-auth-validation.js';
import { processBrowserRequestDirectory } from './ipc-browser-requests.js';
import { canProcessIpcFile, clearIpcRateLimitState } from './ipc-rate-limit.js';
// prettier-ignore
import { validatePermissionIpcJobExecutionTarget, validateUserQuestionIpcJobExecutionTarget } from './ipc-scheduled-interaction-validation.js';
import type { ConversationRoute as RuntimeGroupRecord } from '../domain/types.js';
import { deliverIpcMessage } from './ipc-message-delivery.js';
import { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import {
  IpcRequestWakeupRegistry,
  type IpcRequestWakeupHint,
} from './ipc-request-wakeup-registry.js';
import { IpcWakeupScopeTracker } from './ipc-wakeup-scope.js';
import { processRichInteractionRequestDirectory } from './ipc-rich-interaction-directory.js';
import { resolveRunnerIpcRoute } from './ipc-route-authorization.js';
export type { IpcDeps } from './ipc-domain-types.js';
export { processTaskIpc } from '../jobs/ipc-handler.js';
export { validateIpcAuthRequest } from './ipc-auth-validation.js';
export {
  validatePermissionIpcJobExecutionTarget,
  validateUserQuestionIpcJobExecutionTarget,
} from './ipc-scheduled-interaction-validation.js';
let ipcWatcherRunning = false;
let ipcWatcherTimer: ReturnType<typeof setTimeout> | undefined;
let ipcRootLockPath: string | undefined;
let activeRunnerControlPort: FilesystemRunnerControlPort | undefined;
let activeRequestWakeups: IpcRequestWakeupRegistry | undefined;
const MAX_IN_FLIGHT_INTERACTION_IPC = 100;
const inFlightInteractionIpc = new Set<string>();

export function resolveIpcFoldersFromGroups(
  groupRegistry: Record<string, RuntimeGroupRecord>,
): string[] {
  return Array.from(
    new Set(
      Object.values(groupRegistry)
        .map((group) => group.folder)
        .filter((folder): folder is string => isValidWorkspaceFolder(folder)),
    ),
  );
}

export function resolveIpcTargetJidForSourceGroup(
  groupRegistry: Record<string, RuntimeGroupRecord>,
  sourceAgentFolder: string,
): string | undefined {
  for (const [jid, group] of Object.entries(groupRegistry)) {
    if (group.folder === sourceAgentFolder) return jid;
  }
  return undefined;
}

function releaseIpcRootLock(): void {
  if (!ipcRootLockPath) return;
  try {
    activeRunnerControlPort?.releaseRootLock(ipcRootLockPath);
  } catch (err) {
    // prettier-ignore
    logger.warn({ err, lockPath: ipcRootLockPath }, 'Failed to release IPC lock');
  } finally {
    ipcRootLockPath = undefined;
    activeRunnerControlPort = undefined;
  }
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }

  // prettier-ignore
  const runnerControlPort = new FilesystemRunnerControlPort(path.join(DATA_DIR, 'ipc'));
  activeRunnerControlPort = runnerControlPort;
  const ipcBaseDir = runnerControlPort.baseDir;
  runnerControlPort.ensureRoot();
  try {
    ipcRootLockPath = runnerControlPort.acquireRootLock();
  } catch (err) {
    const lockPath = path.join(ipcBaseDir, '.lock');
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: string }).code)
        : '';
    if (code === 'EEXIST') {
      const recoveredLock = runnerControlPort.recoverRootLock(lockPath);
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
        ipcRootLockPath = runnerControlPort.acquireRootLock();
      } catch (retryErr) {
        const retryCode =
          retryErr && typeof retryErr === 'object' && 'code' in retryErr
            ? String((retryErr as { code?: string }).code)
            : '';
        if (retryCode === 'EEXIST') {
          const retryDetails = runnerControlPort.readRootLock(lockPath);
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
  let processingIpcFiles = false;
  let processAgainAfterCurrentPass = false;
  const wakeupScope = new IpcWakeupScopeTracker();

  const scheduleProcess = (delayMs: number): void => {
    if (!ipcWatcherRunning) return;
    if (ipcWatcherTimer) {
      clearTimeout(ipcWatcherTimer);
      ipcWatcherTimer = undefined;
    }
    ipcWatcherTimer = setTimeout(() => {
      ipcWatcherTimer = undefined;
      void processIpcFiles();
    }, delayMs);
    ipcWatcherTimer.unref?.();
  };

  const scheduleNextPoll = (): void => {
    wakeupScope.scheduleFullScan();
    scheduleProcess(IPC_POLL_INTERVAL);
  };

  const triggerIpcProcessing = (hint?: IpcRequestWakeupHint): void => {
    if (!ipcWatcherRunning) return;
    if (processingIpcFiles) {
      wakeupScope.recordWakeupDuringPass(hint);
      processAgainAfterCurrentPass = true;
      return;
    }
    wakeupScope.recordWakeup(hint);
    scheduleProcess(0);
  };

  activeRequestWakeups = new IpcRequestWakeupRegistry({
    runnerControlPort,
    trigger: triggerIpcProcessing,
    deps: {
      onWatchError: ({ workspaceFolder, lane, error }) => {
        logger.warn(
          { sourceAgentFolder: workspaceFolder, lane, err: error },
          'Failed to watch IPC request directory; falling back to periodic scan',
        );
      },
    },
  });

  const processIpcFiles = async () => {
    if (!ipcWatcherRunning) return;
    if (processingIpcFiles) {
      processAgainAfterCurrentPass = true;
      return;
    }
    processingIpcFiles = true;
    const { scope: processScope, shouldProcessRequestLane } =
      wakeupScope.startPass();
    let scheduleFollowupPass = false;
    try {
      const groupRegistry = deps.conversationRoutes();
      const ipcFolders = resolveIpcFoldersFromGroups(groupRegistry).filter(
        (folder) => {
          if (runnerControlPort.isTrustedRegisteredWorkspace(folder))
            return true;
          initializedLayoutFolders.delete(folder);
          logger.warn(
            { sourceAgentFolder: folder },
            'Skipping IPC processing for untrusted registered group directory',
          );
          return false;
        },
      );

      for (const folder of ipcFolders) {
        if (
          initializedLayoutFolders.has(folder) &&
          runnerControlPort.hasCompleteTrustedWorkspaceLayout(folder)
        ) {
          continue;
        }
        try {
          runnerControlPort.ensureWorkspaceLayout(folder);
          if (runnerControlPort.hasCompleteTrustedWorkspaceLayout(folder)) {
            initializedLayoutFolders.add(folder);
          } else {
            initializedLayoutFolders.delete(folder);
          }
        } catch (err) {
          initializedLayoutFolders.delete(folder);
          logger.warn(
            { sourceAgentFolder: folder, err },
            'Failed to pre-create IPC layout for registered group',
          );
        }
      }
      activeRequestWakeups?.reconcile(ipcFolders);

      const folderTargetJid = new Map<string, string>();
      const folderTargetJids = new Map<string, Set<string>>();
      for (const [jid, group] of Object.entries(groupRegistry)) {
        if (!folderTargetJid.has(group.folder))
          folderTargetJid.set(group.folder, jid);
        const targets = folderTargetJids.get(group.folder) ?? new Set<string>();
        targets.add(jid);
        folderTargetJids.set(group.folder, targets);
      }

      for (const sourceAgentFolder of ipcFolders) {
        const messagesDir = runnerControlPort.requestDir(
          sourceAgentFolder,
          'messages',
        );
        const tasksDir = runnerControlPort.requestDir(
          sourceAgentFolder,
          'tasks',
        );
        const memoryRequestsDir = runnerControlPort.requestDir(
          sourceAgentFolder,
          'memory-requests',
        );
        const browserRequestsDir = runnerControlPort.requestDir(
          sourceAgentFolder,
          'browser-requests',
        );
        const permissionRequestsDir = runnerControlPort.requestDir(
          sourceAgentFolder,
          'permission-requests',
        );
        const userQuestionRequestsDir = runnerControlPort.requestDir(
          sourceAgentFolder,
          'user-questions',
        );

        try {
          if (
            shouldProcessRequestLane(sourceAgentFolder, 'messages') &&
            runnerControlPort.isTrustedRequestDir(sourceAgentFolder, 'messages')
          ) {
            const messageFiles = runnerControlPort.listPendingRequests(
              sourceAgentFolder,
              'messages',
            );
            for (const file of messageFiles) {
              let claimedPath = path.join(messagesDir, file);
              try {
                if (!canProcessIpcFile(sourceAgentFolder, 'messages')) {
                  throw new Error('IPC message rate limit exceeded');
                }
                const claimed = runnerControlPort.claimRequest(
                  sourceAgentFolder,
                  'messages',
                  file,
                );
                claimedPath = claimed.claimedPath;
                const rawData = claimed.raw;
                const data = parseIpcMessage(rawData, sourceAgentFolder);
                const route = resolveRunnerIpcRoute({
                  routes: groupRegistry,
                  sourceAgentFolder,
                  targetJid: data.chatJid,
                  threadId: data.threadId,
                  providerAccountId: data.providerAccountId,
                });
                await deliverIpcMessage({
                  deps,
                  sourceAgentFolder,
                  data,
                  targetJid: route.targetJid,
                  providerAccountId: route.providerAccountId,
                });
                logger.info(
                  { chatJid: route.targetJid, sourceAgentFolder },
                  'IPC message sent',
                );
                runnerControlPort.removeClaimedRequest(claimedPath);
              } catch (err) {
                logger.error(
                  { file, sourceAgentFolder, err },
                  'Error processing IPC message',
                );
                runnerControlPort.archiveFailedRequest(
                  sourceAgentFolder,
                  file,
                  claimedPath,
                );
              }
            }
          } else if (
            processScope === 'all' &&
            runnerControlPort.requestDirExists(sourceAgentFolder, 'messages')
          ) {
            logger.warn(
              { sourceAgentFolder, messagesDir },
              'Ignoring untrusted IPC messages directory',
            );
          }
        } catch (err) {
          logger.error(
            { err, sourceAgentFolder },
            'Error reading IPC messages directory',
          );
        }

        try {
          if (
            shouldProcessRequestLane(sourceAgentFolder, 'tasks') &&
            runnerControlPort.isTrustedRequestDir(sourceAgentFolder, 'tasks')
          ) {
            const taskFiles = runnerControlPort.listPendingRequests(
              sourceAgentFolder,
              'tasks',
            );
            for (const file of taskFiles) {
              let claimedPath = path.join(tasksDir, file);
              let rawTaskData: unknown;
              try {
                if (!canProcessIpcFile(sourceAgentFolder, 'tasks')) {
                  throw new Error('IPC task rate limit exceeded');
                }
                const claimed = runnerControlPort.claimRequest(
                  sourceAgentFolder,
                  'tasks',
                  file,
                );
                claimedPath = claimed.claimedPath;
                rawTaskData = claimed.raw;
                const data = parseTaskIpcData(rawTaskData, sourceAgentFolder);
                if (isLongRunningTask(data.type)) {
                  void processLongRunningTaskIpc({
                    data,
                    sourceAgentFolder,
                    deps,
                    ipcBaseDir,
                    file,
                    claimedPath,
                    runnerControlPort,
                  });
                  continue;
                }
                await processTaskIpc(data, sourceAgentFolder, deps, ipcBaseDir);
                runnerControlPort.removeClaimedRequest(claimedPath);
              } catch (err) {
                logger.error(
                  { file, sourceAgentFolder, err },
                  'Error processing IPC task',
                );
                runnerControlPort.archiveFailedRequest(
                  sourceAgentFolder,
                  file,
                  claimedPath,
                );
              }
            }
          } else if (
            processScope === 'all' &&
            runnerControlPort.requestDirExists(sourceAgentFolder, 'tasks')
          ) {
            logger.warn(
              { sourceAgentFolder, tasksDir },
              'Ignoring untrusted IPC tasks directory',
            );
          }
        } catch (err) {
          logger.error(
            { err, sourceAgentFolder },
            'Error reading IPC tasks directory',
          );
        }

        try {
          if (
            shouldProcessRequestLane(sourceAgentFolder, 'memory-requests') &&
            runnerControlPort.isTrustedRequestDir(
              sourceAgentFolder,
              'memory-requests',
            )
          ) {
            const memoryFiles = runnerControlPort.listPendingRequests(
              sourceAgentFolder,
              'memory-requests',
            );
            for (const file of memoryFiles) {
              let claimedPath = path.join(memoryRequestsDir, file);
              try {
                if (!canProcessIpcFile(sourceAgentFolder, 'memory')) {
                  throw new Error('Memory IPC rate limit exceeded');
                }
                const claimed = runnerControlPort.claimRequest(
                  sourceAgentFolder,
                  'memory-requests',
                  file,
                );
                claimedPath = claimed.claimedPath;
                const rawRequest = claimed.raw;
                const request = parseMemoryIpcRequest(
                  rawRequest,
                  sourceAgentFolder,
                );

                const response = await processMemoryRequest(
                  {
                    requestId: request.requestId,
                    action: request.action,
                    payload: request.payload || {},
                    allowedActions: request.allowedActions,
                    ...(request.deadlineAtMs
                      ? { deadlineAtMs: request.deadlineAtMs }
                      : {}),
                    ...(request.context ? { context: request.context } : {}),
                  },
                  sourceAgentFolder,
                );
                writeMemoryResponse(
                  sourceAgentFolder,
                  request.requestId,
                  response,
                  getIpcResponseSigningPrivateKey(
                    sourceAgentFolder,
                    request.context?.threadId,
                    request.responseKeyId,
                  ),
                );
                runnerControlPort.removeClaimedRequest(claimedPath);
              } catch (err) {
                logger.error(
                  { file, sourceAgentFolder, err },
                  'Error processing memory IPC request',
                );
                runnerControlPort.archiveFailedRequest(
                  sourceAgentFolder,
                  file,
                  claimedPath,
                );
              }
            }
          } else if (
            processScope === 'all' &&
            runnerControlPort.requestDirExists(
              sourceAgentFolder,
              'memory-requests',
            )
          ) {
            logger.warn(
              { sourceAgentFolder, memoryRequestsDir },
              'Ignoring untrusted memory IPC requests directory',
            );
          }
        } catch (err) {
          logger.error(
            { err, sourceAgentFolder },
            'Error reading memory IPC requests directory',
          );
        }

        if (shouldProcessRequestLane(sourceAgentFolder, 'browser-requests')) {
          processBrowserRequestDirectory({
            ipcBaseDir,
            sourceAgentFolder,
            browserRequestsDir,
            runnerControlPort,
            deps,
            logger,
          });
        }

        try {
          if (
            shouldProcessRequestLane(
              sourceAgentFolder,
              'permission-requests',
            ) &&
            runnerControlPort.isTrustedRequestDir(
              sourceAgentFolder,
              'permission-requests',
            )
          ) {
            const permissionFiles = runnerControlPort.listPendingRequests(
              sourceAgentFolder,
              'permission-requests',
            );
            for (const file of permissionFiles) {
              let claimedPath = path.join(permissionRequestsDir, file);
              let requestId: string | undefined;
              let requestThreadId: string | undefined;
              let responseKeyId: string | undefined;
              try {
                if (!canProcessIpcFile(sourceAgentFolder, 'permission')) {
                  throw new Error('Permission IPC rate limit exceeded');
                }
                const claimed = runnerControlPort.claimRequest(
                  sourceAgentFolder,
                  'permission-requests',
                  file,
                );
                claimedPath = claimed.claimedPath;
                const rawRequest = claimed.raw;
                const request = parsePermissionIpcRequest(
                  rawRequest,
                  sourceAgentFolder,
                );
                const route = resolveRunnerIpcRoute({
                  routes: groupRegistry,
                  sourceAgentFolder,
                  targetJid: request.targetJid,
                  threadId: request.threadId,
                  providerAccountId: request.providerAccountId,
                });
                await validatePermissionIpcJobExecutionTarget({
                  request,
                  sourceAgentFolder,
                  deps,
                });
                request.targetJid = route.targetJid;
                request.providerAccountId = route.providerAccountId;
                requestId = request.requestId;
                requestThreadId = request.threadId;
                responseKeyId = request.responseKeyId;
                if (
                  runnerControlPort.responseExists(
                    sourceAgentFolder,
                    'permission-responses',
                    request.requestId,
                  )
                ) {
                  runnerControlPort.removeClaimedRequest(claimedPath);
                  continue;
                }
                if (
                  inFlightInteractionIpc.size >= MAX_IN_FLIGHT_INTERACTION_IPC
                ) {
                  throw new Error(
                    'Too many in-flight interaction IPC requests',
                  );
                }
                const inFlightKey = interactionInFlightKey({
                  sourceAgentFolder,
                  kind: 'permission',
                  threadId: requestThreadId,
                  requestId,
                });
                if (inFlightInteractionIpc.has(inFlightKey)) {
                  throw new Error('Permission IPC request already in flight');
                }
                inFlightInteractionIpc.add(inFlightKey);
                void processPermissionInteractionIpc({
                  request,
                  sourceAgentFolder,
                  deps,
                  ipcBaseDir,
                  file,
                  claimedPath,
                  logger,
                }).finally(() => inFlightInteractionIpc.delete(inFlightKey));
              } catch (err) {
                if (requestId) {
                  writePermissionInteractionFailure({
                    ipcBaseDir,
                    sourceAgentFolder,
                    requestId,
                    threadId: requestThreadId,
                    responseKeyId,
                    logger,
                  });
                }
                logger.error(
                  { file, sourceAgentFolder, err },
                  'Error processing permission IPC request',
                );
                runnerControlPort.archiveFailedRequest(
                  sourceAgentFolder,
                  file,
                  claimedPath,
                );
              }
            }
          } else if (
            processScope === 'all' &&
            runnerControlPort.requestDirExists(
              sourceAgentFolder,
              'permission-requests',
            )
          ) {
            logger.warn(
              { sourceAgentFolder, permissionRequestsDir },
              'Ignoring untrusted permission IPC requests directory',
            );
          }
        } catch (err) {
          logger.error(
            { err, sourceAgentFolder },
            'Error reading permission IPC requests directory',
          );
        }

        processRichInteractionRequestDirectory({
          sourceAgentFolder,
          processScope,
          shouldProcessRequestLane,
          folderTargetJid,
          folderTargetJids,
          groupRegistry,
          inFlightInteractionIpc,
          maxInFlightInteractionIpc: MAX_IN_FLIGHT_INTERACTION_IPC,
          runnerControlPort,
          deps,
          ipcBaseDir,
          logger,
        });

        // Process AskUserQuestion request/response IPC for this group
        try {
          if (
            shouldProcessRequestLane(sourceAgentFolder, 'user-questions') &&
            runnerControlPort.isTrustedRequestDir(
              sourceAgentFolder,
              'user-questions',
            )
          ) {
            const questionFiles = runnerControlPort.listPendingRequests(
              sourceAgentFolder,
              'user-questions',
            );
            for (const file of questionFiles) {
              let claimedPath = path.join(userQuestionRequestsDir, file);
              let requestId: string | undefined;
              let requestThreadId: string | undefined;
              let responseKeyId: string | undefined;
              try {
                if (!canProcessIpcFile(sourceAgentFolder, 'user-question')) {
                  throw new Error('User question IPC rate limit exceeded');
                }
                const claimed = runnerControlPort.claimRequest(
                  sourceAgentFolder,
                  'user-questions',
                  file,
                );
                claimedPath = claimed.claimedPath;
                const rawRequest = claimed.raw;
                const request = parseUserQuestionIpcRequest(
                  rawRequest,
                  sourceAgentFolder,
                );
                const route = resolveRunnerIpcRoute({
                  routes: groupRegistry,
                  sourceAgentFolder,
                  targetJid: request.targetJid,
                  threadId: request.threadId,
                  providerAccountId: request.providerAccountId,
                });
                await validateUserQuestionIpcJobExecutionTarget({
                  request,
                  sourceAgentFolder,
                  deps,
                });
                request.targetJid = route.targetJid;
                request.providerAccountId = route.providerAccountId;
                requestId = request.requestId;
                requestThreadId = request.threadId;
                responseKeyId = request.responseKeyId;
                if (
                  inFlightInteractionIpc.size >= MAX_IN_FLIGHT_INTERACTION_IPC
                ) {
                  throw new Error(
                    'Too many in-flight interaction IPC requests',
                  );
                }
                const inFlightKey = interactionInFlightKey({
                  sourceAgentFolder,
                  kind: 'user-question',
                  threadId: requestThreadId,
                  requestId,
                });
                if (inFlightInteractionIpc.has(inFlightKey)) {
                  throw new Error(
                    'User question IPC request already in flight',
                  );
                }
                inFlightInteractionIpc.add(inFlightKey);
                void processUserQuestionInteractionIpc({
                  request,
                  sourceAgentFolder,
                  deps,
                  ipcBaseDir,
                  file,
                  claimedPath,
                  logger,
                }).finally(() => {
                  inFlightInteractionIpc.delete(inFlightKey);
                });
              } catch (err) {
                if (requestId) {
                  writeUserQuestionInteractionFailure({
                    ipcBaseDir,
                    sourceAgentFolder,
                    requestId,
                    threadId: requestThreadId,
                    responseKeyId,
                    logger,
                  });
                }
                logger.error(
                  { file, sourceAgentFolder, err },
                  'Error processing user question IPC request',
                );
                runnerControlPort.archiveFailedRequest(
                  sourceAgentFolder,
                  file,
                  claimedPath,
                );
              }
            }
          } else if (
            processScope === 'all' &&
            runnerControlPort.requestDirExists(
              sourceAgentFolder,
              'user-questions',
            )
          ) {
            logger.warn(
              { sourceAgentFolder, userQuestionRequestsDir },
              'Ignoring untrusted user question IPC requests directory',
            );
          }
        } catch (err) {
          logger.error(
            { err, sourceAgentFolder },
            'Error reading user question IPC requests directory',
          );
        }
      }
    } finally {
      processingIpcFiles = false;
      scheduleFollowupPass = processAgainAfterCurrentPass;
      processAgainAfterCurrentPass = false;
    }
    if (!ipcWatcherRunning) return;
    if (scheduleFollowupPass) {
      wakeupScope.scheduleFollowupPass();
      scheduleProcess(0);
      return;
    }
    wakeupScope.clearFollowupPass();
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
  clearIpcRateLimitState();
  inFlightInteractionIpc.clear();
  clearConsumedIpcRequestIds({ durable: false });
  activeRequestWakeups?.stop();
  activeRequestWakeups = undefined;
  releaseIpcRootLock();
  logger.info('IPC watcher stopped');
}
