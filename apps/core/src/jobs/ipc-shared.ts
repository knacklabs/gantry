import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import { nowIso } from '../shared/time/datetime.js';
import { writeFileAtomic } from '../infrastructure/filesystem/paths.js';
import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import { isValidWorkspaceFolder } from '../platform/workspace-folder.js';
import {
  getServiceStatus,
  startService,
  stopService,
} from '../infrastructure/service/manager.js';
import { toTrimmedString } from '../shared/object.js';
import { getIpcResponseSigningPrivateKey } from '../runtime/ipc-auth.js';
import type { CoreTaskLifecycleResult } from '../application/core-tools/task-lifecycle.js';
import type { TaskContext } from './ipc-types.js';

const TASK_IPC_RESPONSE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export { toTrimmedString };

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export function taskIpcResponsePath(
  sourceAgentFolder: string,
  taskId: string,
): string {
  return path.join(
    DATA_DIR,
    'ipc',
    sourceAgentFolder,
    'task-responses',
    `task-${taskId}.json`,
  );
}

export function writeTaskIpcResponse(
  sourceAgentFolder: string,
  taskId: string | undefined,
  payload: {
    ok: boolean;
    code?: string;
    message?: string;
    error?: string;
    details?: string[];
    data?: unknown;
  },
  authThreadId?: string,
  responseKeyId?: string,
): void {
  if (!taskId || !TASK_IPC_RESPONSE_ID_PATTERN.test(taskId)) return;
  if (!isValidWorkspaceFolder(sourceAgentFolder)) return;
  const responseDir = path.join(
    DATA_DIR,
    'ipc',
    sourceAgentFolder,
    'task-responses',
  );
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = taskIpcResponsePath(sourceAgentFolder, taskId);
  const responsePayload = {
    taskId,
    ...payload,
    timestamp: nowIso(),
  };
  const privateKeyPem = getIpcResponseSigningPrivateKey(
    sourceAgentFolder,
    authThreadId,
    responseKeyId,
  );
  const signature = signIpcResponsePayload(privateKeyPem, responsePayload);
  if (!signature) return;
  writeJsonAtomic(responsePath, { ...responsePayload, signature });
}

export function createTaskResponder(
  sourceAgentFolder: string,
  taskIdRaw: unknown,
  authThreadId?: string,
  responseKeyId?: string,
): {
  accept: (message: string, code?: string, details?: string[]) => void;
  acceptData: (
    message: string,
    data: unknown,
    code?: string,
    details?: string[],
  ) => void;
  reject: (error: string, code?: string, details?: string[]) => void;
} {
  const taskId = toTrimmedString(taskIdRaw, { maxLen: 128 });
  return {
    accept: (message: string, code?: string, details?: string[]) => {
      writeTaskIpcResponse(
        sourceAgentFolder,
        taskId,
        {
          ok: true,
          ...(code ? { code } : {}),
          message,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
        responseKeyId,
      );
    },
    acceptData: (
      message: string,
      data: unknown,
      code?: string,
      details?: string[],
    ) => {
      writeTaskIpcResponse(
        sourceAgentFolder,
        taskId,
        {
          ok: true,
          ...(code ? { code } : {}),
          message,
          data,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
        responseKeyId,
      );
    },
    reject: (error: string, code?: string, details?: string[]) => {
      writeTaskIpcResponse(
        sourceAgentFolder,
        taskId,
        {
          ok: false,
          ...(code ? { code } : {}),
          error,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
        responseKeyId,
      );
    },
  };
}

export function respondTaskLifecycleResult(
  context: TaskContext,
  result: CoreTaskLifecycleResult,
): void {
  const responder = createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
  if (!result.ok) responder.reject(result.message, result.code);
  else if (result.data === undefined) {
    responder.accept(result.message, result.code);
  } else responder.acceptData(result.message, result.data, result.code);
}

export function restartServiceForRuntimeHome(runtimeHome: string): {
  ok: boolean;
  message: string;
} {
  try {
    const serviceStatus = getServiceStatus(runtimeHome);
    if (serviceStatus.kind === 'launchd') {
      const startOutcome = startService(runtimeHome);
      if (!startOutcome.ok) {
        return { ok: false, message: startOutcome.message };
      }
      return {
        ok: true,
        message: `${startOutcome.message} (restart completed).`,
      };
    }

    const stopOutcome = stopService(runtimeHome);
    if (!stopOutcome.ok) {
      return { ok: false, message: stopOutcome.message };
    }
    const startOutcome = startService(runtimeHome);
    if (!startOutcome.ok) {
      return {
        ok: false,
        message: `Restart failed after stop: ${startOutcome.message}`,
      };
    }
    return {
      ok: true,
      message: `${startOutcome.message} (restart completed).`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
