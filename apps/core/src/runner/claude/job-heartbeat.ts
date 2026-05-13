import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { nowMs } from '../../shared/time/datetime.js';
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
            lastActivityAgoMs: Math.max(0, nowMs() - lastActivityAtMs),
            pendingPermissionRequests: readPendingPermissionRequestCount(),
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
      lastActivityAtMs = nowMs();
    },
    stop: () => clearInterval(timer),
  };
}

function readPendingPermissionRequestCount(): number {
  const responsesDir = path.join(IPC_BASE_DIR, 'permission-responses');
  const responseIds = new Set(
    readJsonFileNames(responsesDir).map((file) => file.replace(/\.json$/, '')),
  );
  return readJsonFileNames(path.join(IPC_BASE_DIR, 'permission-requests'))
    .filter((file) => !responseIds.has(file.replace(/\.json$/, '')))
    .filter((file) => permissionRequestMatchesCurrentRun(file)).length;
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

function permissionRequestMatchesCurrentRun(file: string): boolean {
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
    if (!payload || typeof payload !== 'object') return false;
    const record = payload as Record<string, unknown>;
    return (
      (!process.env.MYCLAW_JOB_ID ||
        record.jobId === process.env.MYCLAW_JOB_ID) &&
      (!process.env.MYCLAW_JOB_RUN_ID ||
        record.runId === process.env.MYCLAW_JOB_RUN_ID)
    );
  } catch {
    return false;
  }
}
