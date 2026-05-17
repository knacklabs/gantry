import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL } from '../config/index.js';
import { ensurePrivateDirSync } from '../shared/private-fs.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
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
import { acquireIpcRootLock, archiveIpcErrorFile, claimIpcFile, ensureGroupIpcLayout, hasCompleteTrustedGroupIpcLayout, isPendingIpcJsonFile, isTrustedDirectory, readIpcRootLockDetails, recoverStaleIpcRootLock } from './ipc-filesystem.js';
// prettier-ignore
import { parseIpcMessage, parseMemoryIpcRequest, parsePermissionIpcRequest, parseUserQuestionIpcRequest } from './ipc-parsing.js';
import { parseTaskIpcData } from './ipc-task-parsing.js';
import { clearConsumedIpcRequestIds } from './ipc-auth-validation.js';
import { processBrowserRequestDirectory } from './ipc-browser-requests.js';
import { canProcessIpcFile, clearIpcRateLimitState } from './ipc-rate-limit.js';
import type { ConversationRoute as RuntimeGroupRecord } from '../domain/types.js';
export type { IpcDeps } from './ipc-domain-types.js';
export { isPendingIpcJsonFile } from './ipc-filesystem.js';
export { processTaskIpc } from '../jobs/ipc-handler.js';
export { validateIpcAuthRequest } from './ipc-auth-validation.js';
let ipcWatcherRunning = false;
let ipcWatcherTimer: ReturnType<typeof setTimeout> | undefined;
let ipcRootLockPath: string | undefined;
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
}): Promise<void> {
  try {
    await processTaskIpc(
      input.data,
      input.sourceAgentFolder,
      input.deps,
      input.ipcBaseDir,
    );
    fs.unlinkSync(input.claimedPath);
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
    archiveIpcErrorFile(
      input.ipcBaseDir,
      input.sourceAgentFolder,
      input.file,
      input.claimedPath,
    );
  }
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
  const { request, sourceAgentFolder, deps } = input;
  if (!request.jobId) return;

  if (!request.targetJid) {
    throw new Error('Scheduled job permission IPC requires targetJid');
  }
  if (!request.runId) {
    throw new Error('Scheduled job permission IPC requires runId');
  }

  const job = await deps.opsRepository.getJobById(request.jobId);
  if (!job) {
    throw new Error('Scheduled job permission IPC references unknown job');
  }
  const execution = job.execution_context;
  if (!execution?.conversationJid) {
    throw new Error(
      'Scheduled job permission IPC requires canonical execution_context',
    );
  }
  const executionGroupScope =
    normalizeNullableString(execution.groupScope) ??
    normalizeNullableString(job.group_scope);
  if (executionGroupScope && executionGroupScope !== sourceAgentFolder) {
    throw new Error(
      'Scheduled job permission IPC source does not match job execution context',
    );
  }
  if (execution.conversationJid !== request.targetJid) {
    throw new Error(
      'Scheduled job permission IPC target does not match job execution context',
    );
  }
  if (
    normalizeNullableString(execution.threadId) !==
    normalizeNullableString(request.threadId)
  ) {
    throw new Error(
      'Scheduled job permission IPC thread does not match job execution context',
    );
  }

  const run = await deps.opsRepository.getJobRunById(request.runId);
  if (!run || run.job_id !== request.jobId) {
    throw new Error('Scheduled job permission IPC run does not match job');
  }
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
  ensurePrivateDirSync(ipcBaseDir);
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
    const groupRegistry = deps.conversationRoutes();
    const ipcFolders = resolveIpcFoldersFromGroups(groupRegistry).filter(
      (folder) => {
        if (isTrustedRegisteredIpcFolder(ipcBaseDir, folder)) return true;
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
      const messagesDir = path.join(ipcBaseDir, sourceAgentFolder, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceAgentFolder, 'tasks');
      const memoryRequestsDir = path.join(
        ipcBaseDir,
        sourceAgentFolder,
        'memory-requests',
      );
      const browserRequestsDir = path.join(
        ipcBaseDir,
        sourceAgentFolder,
        'browser-requests',
      );
      const permissionRequestsDir = path.join(
        ipcBaseDir,
        sourceAgentFolder,
        'permission-requests',
      );
      const userQuestionRequestsDir = path.join(
        ipcBaseDir,
        sourceAgentFolder,
        'user-questions',
      );

      // Process messages from this group's IPC directory
      try {
        if (isTrustedDirectory(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter(isPendingIpcJsonFile);
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceAgentFolder, 'messages')) {
                throw new Error('IPC message rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawData = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
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
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceAgentFolder, err },
                'Error processing IPC message',
              );
              archiveIpcErrorFile(
                ipcBaseDir,
                sourceAgentFolder,
                file,
                claimedPath,
              );
            }
          }
        } else if (fs.existsSync(messagesDir)) {
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
        if (isTrustedDirectory(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter(isPendingIpcJsonFile);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            let claimedPath = filePath;
            let rawTaskData: unknown;
            try {
              if (!canProcessIpcFile(sourceAgentFolder, 'tasks')) {
                throw new Error('IPC task rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              rawTaskData = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
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
                });
                continue;
              }
              await processTaskIpc(data, sourceAgentFolder, deps, ipcBaseDir);
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceAgentFolder, err },
                'Error processing IPC task',
              );
              archiveIpcErrorFile(
                ipcBaseDir,
                sourceAgentFolder,
                file,
                claimedPath,
              );
            }
          }
        } else if (fs.existsSync(tasksDir)) {
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
        if (isTrustedDirectory(memoryRequestsDir)) {
          const memoryFiles = fs
            .readdirSync(memoryRequestsDir)
            .filter(isPendingIpcJsonFile);
          for (const file of memoryFiles) {
            const filePath = path.join(memoryRequestsDir, file);
            let claimedPath = filePath;
            try {
              if (!canProcessIpcFile(sourceAgentFolder, 'memory')) {
                throw new Error('Memory IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
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
              fs.unlinkSync(claimedPath);
            } catch (err) {
              logger.error(
                { file, sourceAgentFolder, err },
                'Error processing memory IPC request',
              );
              archiveIpcErrorFile(
                ipcBaseDir,
                sourceAgentFolder,
                file,
                claimedPath,
              );
            }
          }
        } else if (fs.existsSync(memoryRequestsDir)) {
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
        deps,
        logger,
      });

      // Process permission request/response IPC for this group
      try {
        if (isTrustedDirectory(permissionRequestsDir)) {
          const permissionFiles = fs
            .readdirSync(permissionRequestsDir)
            .filter(isPendingIpcJsonFile);
          for (const file of permissionFiles) {
            const filePath = path.join(permissionRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            let requestThreadId: string | undefined;
            let responseKeyId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceAgentFolder, 'permission')) {
                throw new Error('Permission IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
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
              const responsePath = path.join(
                ipcBaseDir,
                sourceAgentFolder,
                'permission-responses',
                `${request.requestId}.json`,
              );
              if (fs.existsSync(responsePath)) {
                fs.unlinkSync(claimedPath);
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
              archiveIpcErrorFile(
                ipcBaseDir,
                sourceAgentFolder,
                file,
                claimedPath,
              );
            }
          }
        } else if (fs.existsSync(permissionRequestsDir)) {
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
        if (isTrustedDirectory(userQuestionRequestsDir)) {
          const questionFiles = fs
            .readdirSync(userQuestionRequestsDir)
            .filter(isPendingIpcJsonFile);
          for (const file of questionFiles) {
            const filePath = path.join(userQuestionRequestsDir, file);
            let claimedPath = filePath;
            let requestId: string | undefined;
            let requestThreadId: string | undefined;
            let responseKeyId: string | undefined;
            try {
              if (!canProcessIpcFile(sourceAgentFolder, 'user-question')) {
                throw new Error('User question IPC rate limit exceeded');
              }
              claimedPath = claimIpcFile(filePath);
              const rawRequest = JSON.parse(
                fs.readFileSync(claimedPath, 'utf-8'),
              );
              const request = parseUserQuestionIpcRequest(
                rawRequest,
                sourceAgentFolder,
              );
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
              archiveIpcErrorFile(
                ipcBaseDir,
                sourceAgentFolder,
                file,
                claimedPath,
              );
            }
          }
        } else if (fs.existsSync(userQuestionRequestsDir)) {
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
  clearConsumedIpcRequestIds();
  releaseIpcRootLock();
  logger.info('IPC watcher stopped');
}
