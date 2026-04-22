import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { DATA_DIR } from '../core/config.js';
import { nowIso } from '../core/datetime.js';
import { writeFileAtomic } from '../core/fs-paths.js';
import { JobExecutionMode, RegisteredGroup } from '../core/types.js';
import { isValidGroupFolder } from '../platform/group-folder.js';
import {
  getServiceStatus,
  startService,
  stopService,
} from '../cli/service-manager.js';

const TASK_IPC_RESPONSE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export { toTrimmedString } from '../core/object.js';

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

export function jobBelongsToSourceGroup(
  job: { group_scope: string; linked_sessions: string[] },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  if (job.group_scope !== sourceGroup) return false;
  return job.linked_sessions.every((jid) => {
    const group = registeredGroups[jid];
    return !!group && group.folder === sourceGroup;
  });
}

export function jobBelongsToAuthThread(
  job: { thread_id: string | null },
  authThreadId?: string,
): boolean {
  if (!authThreadId) return true;
  return (job.thread_id || null) === authThreadId;
}

export function generateJobId(params: {
  name: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  groupScope: string;
}): string {
  const base = JSON.stringify({
    name: params.name,
    prompt: params.prompt,
    scheduleType: params.scheduleType,
    scheduleValue: params.scheduleValue,
    groupScope: params.groupScope,
  });
  const hash = createHash('sha256').update(base).digest('hex').slice(0, 12);
  const slug = params.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `job-${slug || 'scheduled'}-${hash}`;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export function writeTaskIpcResponse(
  sourceGroup: string,
  taskId: string | undefined,
  payload: {
    ok: boolean;
    message?: string;
    error?: string;
    details?: string[];
  },
): void {
  if (!taskId || !TASK_IPC_RESPONSE_ID_PATTERN.test(taskId)) return;
  if (!isValidGroupFolder(sourceGroup)) return;
  const responseDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'task-responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const responsePath = path.join(responseDir, `task-${taskId}.json`);
  writeJsonAtomic(responsePath, {
    taskId,
    ...payload,
    timestamp: nowIso(),
  });
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
