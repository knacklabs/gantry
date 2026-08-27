import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { nowMs } from '../../../../shared/time/datetime.js';
import type { AgentRunnerInput } from './types.js';
import type { writeOutput } from './output.js';
import { permissionRequestToolName } from './permission-suggestions.js';
import { inFlightPermissionRequests } from './permission-callback.js';

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
    const pendingPermissions = inFlightPermissionRequests();
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
  let stopped = false;

  return {
    markActivity,
    recordToolActivity: (toolName) => {
      totalToolCalls += 1;
      currentTool = permissionRequestToolName(toolName);
      lastTool = currentTool;
      lastActivityAtMs = nowMs();
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      emitHeartbeat();
    },
  };
}
