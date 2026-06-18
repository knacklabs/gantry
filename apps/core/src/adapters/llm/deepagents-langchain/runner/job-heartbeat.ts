import fs from 'node:fs';
import path from 'node:path';

import { RUNTIME_EVENT_TYPES } from '../../../../domain/events/runtime-event-types.js';
import { nowMs } from '../../../../shared/time/datetime.js';
import type { RunnerOutputFrame } from '../../../../runner/runner-frame.js';
import { resolveWorkspaceIpcDir } from './runtime-env.js';
import type { DeepAgentRunnerInput } from './types.js';

// Scheduled-job heartbeat parity for the DeepAgents lane. Mirrors the Anthropic
// runner's startJobHeartbeat (anthropic-claude-agent/runner/job-heartbeat.ts):
// for a scheduled run it emits a JOB_HEARTBEAT runtime-event frame every 15s so
// the host's idle-stall detection (agent-spawn-scheduled-idle.ts
// readScheduledJobHeartbeat) and lease activity tracking behave identically for
// both engines. Interactive runs (no jobId) emit nothing extra and the activity
// callbacks are no-ops, exactly like the Anthropic lane.

const JOB_HEARTBEAT_INTERVAL_MS = 15_000;

export interface DeepAgentJobHeartbeat {
  /** Reset the idle timer (e.g. on each streamed model delta). */
  markActivity(): void;
  /** Record a tool invocation by name; bumps the tool-call counters. */
  recordToolActivity(toolName: string): void;
  /** Stop the periodic emitter. Idempotent. */
  stop(): void;
}

export function startDeepAgentJobHeartbeat(input: {
  agentInput: DeepAgentRunnerInput;
  writeFrame: (frame: RunnerOutputFrame) => void;
  getSessionId: () => string | undefined;
}): DeepAgentJobHeartbeat {
  const { agentInput } = input;
  let lastActivityAtMs = nowMs();
  let currentTool: string | undefined;
  let lastTool: string | undefined;
  let totalToolCalls = 0;

  const markActivity = () => {
    lastActivityAtMs = nowMs();
    currentTool = undefined;
  };

  // Only scheduled jobs emit heartbeats; live turns rely on streamed frames and
  // the live-turn lease heartbeat, matching the Anthropic lane gate.
  if (!agentInput.isScheduledJob || !agentInput.jobId) {
    return {
      markActivity,
      recordToolActivity: markActivity,
      stop: () => undefined,
    };
  }

  const emitHeartbeat = () => {
    const pending = readPendingPermissionRequests(agentInput);
    input.writeFrame({
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
            pendingPermissionRequests: pending.count,
            pendingPermissionToolNames: pending.toolNames,
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
      currentTool = toolName;
      lastTool = toolName;
      lastActivityAtMs = nowMs();
    },
    stop: () => clearInterval(timer),
  };
}

// Counts this run's permission requests still awaiting a response, scanning the
// neutral permission IPC dirs the DeepAgents runner writes through
// permission-ipc-client.ts. Best-effort: a missing dir means zero pending.
function readPendingPermissionRequests(agentInput: DeepAgentRunnerInput): {
  count: number;
  toolNames: string[];
} {
  let workspaceIpcDir: string;
  try {
    workspaceIpcDir = resolveWorkspaceIpcDir(agentInput.workspaceFolder);
  } catch {
    return { count: 0, toolNames: [] };
  }
  const requestsDir = path.join(workspaceIpcDir, 'permission-requests');
  const responsesDir = path.join(workspaceIpcDir, 'permission-responses');
  const respondedIds = new Set(jsonFileBaseNames(responsesDir));
  const toolNames = new Set<string>();
  let count = 0;
  for (const base of jsonFileBaseNames(requestsDir)) {
    if (respondedIds.has(base)) continue;
    count += 1;
    const toolName = readRequestToolName(
      path.join(requestsDir, `${base}.json`),
    );
    if (toolName) toolNames.add(toolName);
  }
  return { count, toolNames: Array.from(toolNames) };
}

function jsonFileBaseNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json') && !file.endsWith('.tmp'))
      .map((file) => file.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

function readRequestToolName(file: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const payload =
      raw && typeof raw === 'object' && 'payload' in raw
        ? (raw as { payload?: unknown }).payload
        : raw;
    if (!payload || typeof payload !== 'object') return undefined;
    const toolName = (payload as { toolName?: unknown }).toolName;
    return typeof toolName === 'string' ? toolName : undefined;
  } catch {
    return undefined;
  }
}
