import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config/index.js';
import { nowIso } from '../infrastructure/time/datetime.js';
import { writeFileAtomic } from '../infrastructure/filesystem/paths.js';
import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import { JobExecutionMode } from '../domain/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import {
  getServiceStatus,
  startService,
  stopService,
} from '../infrastructure/service/manager.js';
import { toTrimmedString } from '../shared/object.js';
import { getIpcResponseSigningPrivateKey } from '../runtime/ipc-auth.js';

const TASK_IPC_RESPONSE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export { toTrimmedString };

export function normalizeIpcExecutionMode(
  executionMode: unknown,
  serialize: unknown,
  fallback: JobExecutionMode = 'parallel',
): JobExecutionMode {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean') {
    return serialize ? 'serialized' : 'parallel';
  }
  return fallback;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export function writeTaskIpcResponse(
  sourceGroup: string,
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
): void {
  if (!taskId || !TASK_IPC_RESPONSE_ID_PATTERN.test(taskId)) return;
  if (!isValidGroupFolder(sourceGroup)) return;
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'task-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `task-${taskId}.json`);
  const responsePayload = {
    taskId,
    ...payload,
    timestamp: nowIso(),
  };
  const privateKeyPem = getIpcResponseSigningPrivateKey(
    sourceGroup,
    authThreadId,
  );
  const signature = signIpcResponsePayload(privateKeyPem, responsePayload);
  writeJsonAtomic(
    responsePath,
    signature ? { ...responsePayload, signature } : responsePayload,
  );
}

export function createTaskResponder(
  sourceGroup: string,
  taskIdRaw: unknown,
  authThreadId?: string,
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
        sourceGroup,
        taskId,
        {
          ok: true,
          ...(code ? { code } : {}),
          message,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
      );
    },
    acceptData: (
      message: string,
      data: unknown,
      code?: string,
      details?: string[],
    ) => {
      writeTaskIpcResponse(
        sourceGroup,
        taskId,
        {
          ok: true,
          ...(code ? { code } : {}),
          message,
          data,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
      );
    },
    reject: (error: string, code?: string, details?: string[]) => {
      writeTaskIpcResponse(
        sourceGroup,
        taskId,
        {
          ok: false,
          ...(code ? { code } : {}),
          error,
          ...(details && details.length > 0 ? { details } : {}),
        },
        authThreadId,
      );
    },
  };
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
