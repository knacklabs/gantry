import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startDeepAgentJobHeartbeat } from '@core/adapters/llm/deepagents-langchain/runner/job-heartbeat.js';
import type { DeepAgentRunnerInput } from '@core/adapters/llm/deepagents-langchain/runner/types.js';
import type { RunnerOutputFrame } from '@core/runner/runner-frame.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';

let ipcDir: string;
let priorIpcDir: string | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepagents-heartbeat-'));
  priorIpcDir = process.env.GANTRY_IPC_DIR;
  process.env.GANTRY_IPC_DIR = ipcDir;
});

afterEach(() => {
  vi.useRealTimers();
  if (priorIpcDir === undefined) delete process.env.GANTRY_IPC_DIR;
  else process.env.GANTRY_IPC_DIR = priorIpcDir;
  fs.rmSync(ipcDir, { recursive: true, force: true });
});

const SCHEDULED_INPUT: DeepAgentRunnerInput = {
  prompt: 'do the thing',
  appId: 'default',
  agentId: 'agent-1',
  workspaceFolder: 'agent_folder',
  chatJid: 'chat:1',
  isScheduledJob: true,
  jobId: 'job-1',
  runId: 'run-1',
};

describe('startDeepAgentJobHeartbeat', () => {
  it('emits a JOB_HEARTBEAT frame on the interval for a scheduled job', () => {
    const frames: RunnerOutputFrame[] = [];
    const heartbeat = startDeepAgentJobHeartbeat({
      agentInput: SCHEDULED_INPUT,
      writeFrame: (frame) => frames.push(frame),
      getSessionId: () => 'session-x',
    });

    vi.advanceTimersByTime(15_000);
    heartbeat.stop();

    expect(frames).toHaveLength(1);
    const event = frames[0].runtimeEvents?.[0];
    expect(event?.eventType).toBe(RUNTIME_EVENT_TYPES.JOB_HEARTBEAT);
    expect(event?.actor).toBe('runner');
    expect(event?.jobId).toBe('job-1');
    expect(event?.runId).toBe('run-1');
    const payload = event?.payload as Record<string, unknown>;
    expect(typeof payload.lastActivityAt).toBe('string');
    expect(typeof payload.lastActivityAgoMs).toBe('number');
    expect(payload.pendingPermissionRequests).toBe(0);
    expect(payload.totalToolCalls).toBe(0);
    expect(frames[0].newSessionId).toBe('session-x');
  });

  it('counts tool activity and surfaces the current tool', () => {
    const frames: RunnerOutputFrame[] = [];
    const heartbeat = startDeepAgentJobHeartbeat({
      agentInput: SCHEDULED_INPUT,
      writeFrame: (frame) => frames.push(frame),
      getSessionId: () => undefined,
    });
    heartbeat.recordToolActivity('mcp__gantry__send_message');
    heartbeat.recordToolActivity('mcp__gantry__file');

    vi.advanceTimersByTime(15_000);
    heartbeat.stop();

    const payload = frames[0].runtimeEvents?.[0]?.payload as Record<
      string,
      unknown
    >;
    expect(payload.totalToolCalls).toBe(2);
    expect(payload.currentTool).toBe('mcp__gantry__file');
    expect(payload.lastTool).toBe('mcp__gantry__file');
  });

  it('counts pending permission requests for the run from the IPC dir', () => {
    const requestsDir = path.join(
      ipcDir,
      'agent_folder',
      'permission-requests',
    );
    fs.mkdirSync(requestsDir, { recursive: true });
    fs.writeFileSync(
      path.join(requestsDir, 'perm-1.json'),
      JSON.stringify({ payload: { toolName: 'mcp__server__do' } }),
    );

    const frames: RunnerOutputFrame[] = [];
    const heartbeat = startDeepAgentJobHeartbeat({
      agentInput: SCHEDULED_INPUT,
      writeFrame: (frame) => frames.push(frame),
      getSessionId: () => undefined,
    });
    vi.advanceTimersByTime(15_000);
    heartbeat.stop();

    const payload = frames[0].runtimeEvents?.[0]?.payload as Record<
      string,
      unknown
    >;
    expect(payload.pendingPermissionRequests).toBe(1);
    expect(payload.pendingPermissionToolNames).toEqual(['mcp__server__do']);
  });

  it('emits nothing and no-ops for an interactive (non-scheduled) run', () => {
    const frames: RunnerOutputFrame[] = [];
    const heartbeat = startDeepAgentJobHeartbeat({
      agentInput: {
        ...SCHEDULED_INPUT,
        isScheduledJob: false,
        jobId: undefined,
      },
      writeFrame: (frame) => frames.push(frame),
      getSessionId: () => undefined,
    });
    heartbeat.markActivity();
    heartbeat.recordToolActivity('x');
    vi.advanceTimersByTime(60_000);
    heartbeat.stop();
    expect(frames).toHaveLength(0);
  });
});
