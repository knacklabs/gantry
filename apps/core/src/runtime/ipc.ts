import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config/index.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import { logger } from '../infrastructure/logging/logger.js';
// prettier-ignore
import { processMemoryRequest, writeMemoryResponse } from '../memory/memory-ipc.js';
// prettier-ignore
import { getIpcResponseSigningPrivateKey } from './ipc-auth.js';
import type { IpcDeps } from './ipc-domain-types.js';
import { writeTaskIpcResponse } from '../jobs/ipc-shared.js';
// prettier-ignore
import { interactionInFlightKey, processPermissionInteractionIpc, processUserQuestionInteractionIpc, writePermissionInteractionFailure, writeUserQuestionInteractionFailure } from './ipc-interaction-processing.js';
import { processTaskIpc } from '../jobs/ipc-handler.js';
// prettier-ignore
import { parseIpcMessage, parseMemoryIpcRequest, parsePermissionIpcRequest, parseUserQuestionIpcRequest } from './ipc-parsing.js';
import { parseTaskIpcData } from './ipc-task-parsing.js';
import { clearConsumedIpcRequestIds } from './ipc-auth-validation.js';
import { processBrowserRequestDirectory } from './ipc-browser-requests.js';
import { canProcessIpcFile, clearIpcRateLimitState } from './ipc-rate-limit.js';
import type { ConversationRoute as RuntimeGroupRecord } from '../domain/types.js';
import { FilesystemRunnerControlPort } from './filesystem-runner-control-port.js';
import type { RunnerControlPort } from './runner-control-port.js';
export type { IpcDeps } from './ipc-domain-types.js';
export { processTaskIpc } from '../jobs/ipc-handler.js';
export { validateIpcAuthRequest } from './ipc-auth-validation.js';
let ipcWatcherRunning = false;
let ipcWatcherTimer: ReturnType<typeof setTimeout> | undefined;
let ipcRootLockPath: string | undefined;
let activeRunnerControlPort: FilesystemRunnerControlPort | undefined;
const MAX_IN_FLIGHT_INTERACTION_IPC = 100;
const inFlightInteractionIpc = new Set<string>();

const isLongRunningTask = (type: string): boolean =>
  type.startsWith('mcp_') || type === 'scheduler_wait_for_events';

async function processLongRunningTaskIpc(input: {
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
    // prettier-ignore
    input.runnerControlPort.archiveFailedRequest(input.sourceAgentFolder, input.file, input.claimedPath);
  }
}

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

function normalizeNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function validatePermissionIpcJobExecutionTarget(input: {
  request: ReturnType<typeof parsePermissionIpcRequest>;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<void> {
  await validateScheduledInteractionIpcJobExecutionTarget({
    ...input,
    kind: 'permission',
  });
}

export async function validateUserQuestionIpcJobExecutionTarget(input: {
  request: ReturnType<typeof parseUserQuestionIpcRequest>;
  sourceAgentFolder: string;
  deps: IpcDeps;
}): Promise<void> {
  await validateScheduledInteractionIpcJobExecutionTarget({
    ...input,
    kind: 'user question',
  });
}

async function validateScheduledInteractionIpcJobExecutionTarget(input: {
  request: {
    jobId?: string;
    runId?: string;
    targetJid?: string;
    threadId?: string;
  };
  sourceAgentFolder: string;
  deps: IpcDeps;
  kind: 'permission' | 'user question';
}): Promise<void> {
  const { request, sourceAgentFolder, deps, kind } = input;
  if (!request.jobId) return;

  if (!request.targetJid) {
    throw new Error(`Scheduled job ${kind} IPC requires targetJid`);
  }
  if (!request.runId) {
    throw new Error(`Scheduled job ${kind} IPC requires runId`);
  }

  const job = await deps.opsRepository.getJobById(request.jobId);
  if (!job) {
    throw new Error(`Scheduled job ${kind} IPC references unknown job`);
  }
  const execution = job.execution_context;
  if (!execution?.conversationJid) {
    throw new Error(
      `Scheduled job ${kind} IPC requires canonical execution_context`,
    );
  }
  const executionWorkspaceKey =
    normalizeNullableString(execution.workspaceKey) ??
    normalizeNullableString(job.workspace_key);
  if (executionWorkspaceKey && executionWorkspaceKey !== sourceAgentFolder) {
    throw new Error(
      `Scheduled job ${kind} IPC source does not match job execution context`,
    );
  }
  if (execution.conversationJid !== request.targetJid) {
    throw new Error(
      `Scheduled job ${kind} IPC target does not match job execution context`,
    );
  }
  if (
    normalizeNullableString(execution.threadId) !==
    normalizeNullableString(request.threadId)
  ) {
    throw new Error(
      `Scheduled job ${kind} IPC thread does not match job execution context`,
    );
  }

  const run = await deps.opsRepository.getJobRunById(request.runId);
  if (!run || run.job_id !== request.jobId) {
    throw new Error(`Scheduled job ${kind} IPC run does not match job`);
  }
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

  const scheduleNextPoll = (): void => {
    if (!ipcWatcherRunning) return;
    ipcWatcherTimer = setTimeout(() => {
      void processIpcFiles();
    }, IPC_POLL_INTERVAL);
  };

  const processIpcFiles = async () => {
    if (!ipcWatcherRunning) return;
    const groupRegistry = deps.conversationRoutes();
    const ipcFolders = resolveIpcFoldersFromGroups(groupRegistry).filter(
      (folder) => {
        if (runnerControlPort.isTrustedRegisteredWorkspace(folder)) return true;
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
      const tasksDir = runnerControlPort.requestDir(sourceAgentFolder, 'tasks');
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

      // Process messages from this group's IPC directory
      try {
        if (
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
              // Authorization: verify this group can send to this chatJid
              const targetGroup = groupRegistry[data.chatJid];
              if (targetGroup && targetGroup.folder === sourceAgentFolder) {
                if (data.threadId) {
                  await deps.sendMessage(data.chatJid, data.text, {
                    threadId: data.threadId,
                  });
                } else {
                  await deps.sendMessage(data.chatJid, data.text);
                }
                logger.info(
                  { chatJid: data.chatJid, sourceAgentFolder },
                  'IPC message sent',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceAgentFolder },
                  'Unauthorized IPC message attempt blocked',
                );
              }
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

      // Process tasks from this group's IPC directory
      try {
        if (runnerControlPort.isTrustedRequestDir(sourceAgentFolder, 'tasks')) {
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
              // Pass source group identity to processTaskIpc for authorization
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

      // Process memory request/response IPC for this group
      try {
        if (
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

      // Process browser request/response IPC for this group
      processBrowserRequestDirectory({
        ipcBaseDir,
        sourceAgentFolder,
        browserRequestsDir,
        runnerControlPort,
        deps,
        logger,
      });

      // Process permission request/response IPC for this group
      try {
        if (
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
              if (
                request.targetJid &&
                !folderTargetJids.get(sourceAgentFolder)?.has(request.targetJid)
              ) {
                throw new Error(
                  'Permission IPC target does not belong to the requesting agent folder',
                );
              }
              await validatePermissionIpcJobExecutionTarget({
                request,
                sourceAgentFolder,
                deps,
              });
              request.targetJid =
                request.targetJid || folderTargetJid.get(sourceAgentFolder);
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
                throw new Error('Too many in-flight interaction IPC requests');
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

      // Process AskUserQuestion request/response IPC for this group
      try {
        if (
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
              if (
                request.targetJid &&
                !folderTargetJids.get(sourceAgentFolder)?.has(request.targetJid)
              ) {
                throw new Error(
                  'User question IPC target does not belong to the requesting agent folder',
                );
              }
              await validateUserQuestionIpcJobExecutionTarget({
                request,
                sourceAgentFolder,
                deps,
              });
              request.targetJid =
                request.targetJid || folderTargetJid.get(sourceAgentFolder);
              requestId = request.requestId;
              requestThreadId = request.threadId;
              responseKeyId = request.responseKeyId;
              if (
                inFlightInteractionIpc.size >= MAX_IN_FLIGHT_INTERACTION_IPC
              ) {
                throw new Error('Too many in-flight interaction IPC requests');
              }
              const inFlightKey = interactionInFlightKey({
                sourceAgentFolder,
                kind: 'user-question',
                threadId: requestThreadId,
                requestId,
              });
              if (inFlightInteractionIpc.has(inFlightKey)) {
                throw new Error('User question IPC request already in flight');
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
  releaseIpcRootLock();
  logger.info('IPC watcher stopped');
}
