import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { nowMs } from '../../../../shared/time/datetime.js';
import { IPC_BASE_DIR } from './runtime-env.js';
import type { AgentRunnerInput } from './types.js';
import type { writeOutput } from './output.js';
import { permissionRequestToolName } from './permission-suggestions.js';

const JOB_HEARTBEAT_INTERVAL_MS = 15_000;

type RunnerWriteOutput = typeof writeOutput;

export function startJobHeartbeat(input: {
  agentInput: AgentRunnerInput;
  writeOutput: RunnerWriteOutput;
  getSessionId: () => string | undefined;
}): {
  markActivity(): void;
  recordToolActivity(toolName: string): void;
  stop(): void;
} {
  const { agentInput } = input;
  let lastActivityAtMs = nowMs();
  let currentTool: string | undefined;
  let lastTool: string | undefined;
  let totalToolCalls = 0;
  const markActivity = () => {
    lastActivityAtMs = nowMs();
    currentTool = undefined;
  };

  if (!agentInput.isScheduledJob || !agentInput.jobId) {
    return {
      markActivity,
      recordToolActivity: markActivity,
      stop: () => undefined,
    };
  }

  const emitHeartbeat = () => {
    const pendingPermissions = readPendingPermissionRequests();
    input.writeOutput({
      status: 'success',
      result: null,
      newSessionId: input.getSessionId(),
      runtimeEvents: [
        {
          appId: agentInput.appId,
          agentId: agentInput.agentId,
          runId: agentInput.runId,
          jobId: agentInput.jobId,
          conversationId: agentInput.chatJid,
          threadId: agentInput.threadId,
          eventType: RUNTIME_EVENT_TYPES.JOB_HEARTBEAT,
          actor: 'runner',
          responseMode: 'none',
          payload: {
            ...(currentTool ? { currentTool } : {}),
            ...(lastTool ? { lastTool } : {}),
            lastActivityAt: new Date(lastActivityAtMs).toISOString(),
            lastActivityAgoMs: Math.max(0, nowMs() - lastActivityAtMs),
            pendingPermissionRequests: pendingPermissions.count,
            pendingPermissionToolNames: pendingPermissions.toolNames,
            totalToolCalls,
          },
        },
      ],
    });
  };
  const timer = setInterval(emitHeartbeat, JOB_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    markActivity,
    recordToolActivity: (toolName) => {
      totalToolCalls += 1;
      currentTool = permissionRequestToolName(toolName);
      lastTool = currentTool;
      lastActivityAtMs = nowMs();
    },
    stop: () => clearInterval(timer),
  };
}

function readPendingPermissionRequests(): {
  count: number;
  toolNames: string[];
} {
  const responsesDir = path.join(IPC_BASE_DIR, 'permission-responses');
  const responseIds = new Set(
    readJsonFileNames(responsesDir).map((file) => file.replace(/\.json$/, '')),
  );
  const requests = readJsonFileNames(
    path.join(IPC_BASE_DIR, 'permission-requests'),
  )
    .filter((file) => !responseIds.has(file.replace(/\.json$/, '')))
    .map((file) => readCurrentRunPermissionRequest(file))
    .filter((request): request is { toolName?: string } => Boolean(request));
  const toolNames = Array.from(
    new Set(
      requests
        .map((request) => request.toolName)
        .filter((toolName): toolName is string => Boolean(toolName)),
    ),
  );
  return { count: requests.length, toolNames };
}

function readJsonFileNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json') && !file.endsWith('.tmp'));
  } catch {
    return [];
  }
}

function readCurrentRunPermissionRequest(
  file: string,
): { toolName?: string } | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(
        path.join(IPC_BASE_DIR, 'permission-requests', file),
        'utf8',
      ),
    );
    const payload =
      raw && typeof raw === 'object' && 'payload' in raw
        ? (raw as { payload?: unknown }).payload
        : raw;
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    const matches =
      (!process.env.GANTRY_JOB_ID ||
        record.jobId === process.env.GANTRY_JOB_ID) &&
      (!process.env.GANTRY_JOB_RUN_ID ||
        record.runId === process.env.GANTRY_JOB_RUN_ID);
    if (!matches) return undefined;
    return {
      toolName:
        typeof record.toolName === 'string'
          ? permissionRequestToolName(record.toolName)
          : undefined,
    };
  } catch {
    return undefined;
  }
}
