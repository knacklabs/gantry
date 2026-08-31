import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const processTaskIpcMock = vi.hoisted(() => vi.fn());

vi.mock('@core/runtime/ipc.js', () => ({
  processTaskIpc: processTaskIpcMock,
}));

import { DATA_DIR } from '@core/config/index.js';
import { registerRuntimeLiveStopMessageAction } from '@core/app/bootstrap/runtime-live-stop-message-action.js';
import { JobManagementService } from '@core/application/jobs/job-management-service.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '@core/application/jobs/job-readiness-service.js';
import { runtimeJobSchedulePlanner } from '@core/jobs/job-schedule-planner.js';
import { writeTaskIpcResponse } from '@core/jobs/ipc-shared.js';
import { permissionRunRestriction } from '@core/runtime/permission-decision-coordinator.js';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'card check 2',
    workspace_key: 'main_agent',
    session_id: 'session-1',
    status: 'paused',
    pause_reason: SETUP_REQUIRED_PAUSE_REASON,
    prompt: 'count files',
    schedule_type: 'manual',
    schedule_value: null,
    setup_state: {
      state: 'missing_permission',
      checked_at: '2026-08-31T00:00:00.000Z',
      fingerprint: 'fp-tool',
      blockers: [
        {
          state: 'missing_permission',
          type: 'tool',
          id: 'RunCommand',
          summary: 'Tool access: RunCommand',
          action: {
            kind: 'instruction',
            text: 'Reformulate the command, then resume the job.',
          },
        },
      ],
    },
    ...overrides,
  };
}

function makeService(job: Record<string, unknown>) {
  const state = { job };
  const ops = {
    getJobById: vi.fn(async () => state.job),
    updateJob: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      state.job = { ...state.job, ...patch };
      return state.job;
    }),
  };
  const control = {
    createJobTrigger: vi.fn(async (request: { triggerId?: string }) => ({
      triggerId: request.triggerId ?? 'trigger-1',
      status: 'pending',
    })),
    markTriggerCompleted: vi.fn(),
    getTriggerById: vi.fn(async () => undefined),
    getAppSessionById: vi.fn(async () => ({
      sessionId: 'session-1',
      appId: 'app-one',
      conversationJid: 'app:app-one:conv-1',
      workspaceKey: 'main_agent',
      defaultResponseMode: 'sse',
      defaultWebhookId: null,
    })),
  };
  const triggerQueue = {
    isReady: vi.fn(() => true),
    enqueue: vi.fn(async () => undefined),
  };
  const service = new JobManagementService({
    ops: ops as never,
    scheduler: { requestSchedulerSync: vi.fn() },
    schedulePlanner: runtimeJobSchedulePlanner,
    control: control as never,
    runtimeEvents: { publish: vi.fn() } as never,
    triggerQueue,
  });
  return { service, ops, control, triggerQueue, state };
}

const access = {
  sourceAgentFolder: 'main_agent',
  originConversationJid: 'sl:C123',
  conversationBindings: { 'sl:C123': { folder: 'main_agent' } },
  sourceAgentFolderJids: ['sl:C123'],
};

describe('scheduler message actions (CARDFIX-1)', () => {
  afterEach(() => {
    processTaskIpcMock.mockReset();
    fs.rmSync(path.join(DATA_DIR, 'ipc', 'main_agent', 'task-responses'), {
      recursive: true,
      force: true,
    });
  });

  it('retry-and-ask starts exactly one fresh run in ask mode and is idempotent', async () => {
    const { service, ops, triggerQueue } = makeService(makeJob());
    const first = await service.retryJobWithAskFromMcp({
      jobId: 'job-1',
      runId: 'run-1',
      access,
    });
    expect(first.queued).toBe(true);
    // One durable trigger per pause story: ids derive from the setup
    // fingerprint, and the enqueued run uses exactly that trigger.
    expect(ops.updateJob).toHaveBeenCalledWith(
      'job-1',
      expect.objectContaining({ status: 'active', pause_reason: null }),
    );
    expect(triggerQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(triggerQueue.enqueue).toHaveBeenCalledWith(
      'job-1',
      first.triggerId,
      {
        runId: first.runId,
      },
    );
    // Second tap: the job is no longer setup-paused; no second run stacks.
    await expect(
      service.retryJobWithAskFromMcp({
        jobId: 'job-1',
        runId: 'run-2',
        access,
      }),
    ).rejects.toThrow(/already used|no longer paused/);
    expect(triggerQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('replays a pending retry trigger after a crash between resume and enqueue', async () => {
    const { service, control, triggerQueue, ops } = makeService(
      makeJob({ status: 'active', pause_reason: null }),
    );
    control.getTriggerById.mockResolvedValueOnce({
      triggerId: 'trigger-1',
      status: 'pending',
    } as never);
    const replay = await service.retryJobWithAskFromMcp({
      jobId: 'job-1',
      runId: 'run-1',
      access,
    });
    expect(replay.queued).toBe(true);
    expect(triggerQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(ops.updateJob).not.toHaveBeenCalled();
    expect(control.createJobTrigger).not.toHaveBeenCalled();
  });

  it('refuses a retry whose fingerprint trigger was already consumed', async () => {
    const { service, control, triggerQueue } = makeService(makeJob());
    control.createJobTrigger.mockResolvedValueOnce({
      triggerId: 'trigger-1',
      status: 'completed',
    } as never);
    await expect(
      service.retryJobWithAskFromMcp({
        jobId: 'job-1',
        runId: 'run-1',
        access,
      }),
    ).rejects.toThrow(/already used/);
    expect(triggerQueue.enqueue).not.toHaveBeenCalled();
  });

  it('refuses retry-and-ask when a blocker is not a runtime-askable tool', async () => {
    const job = makeJob();
    (
      job.setup_state as { blockers: Array<{ type: string }> }
    ).blockers[0].type = 'credential';
    const { service, triggerQueue } = makeService(job);
    await expect(
      service.retryJobWithAskFromMcp({
        jobId: 'job-1',
        runId: 'run-1',
        access,
      }),
    ).rejects.toThrow(/only covers tool permissions/);
    expect(triggerQueue.enqueue).not.toHaveBeenCalled();
  });

  it('pause job action pauses the job for a same-channel approver', async () => {
    processTaskIpcMock.mockImplementation(
      async (
        data: {
          type?: string;
          taskId?: string;
          authThreadId?: string;
          responseKeyId?: string;
        },
        sourceAgentFolder: string,
      ) => {
        writeTaskIpcResponse(
          sourceAgentFolder,
          data.taskId,
          { ok: true, message: 'Scheduler job paused (job-1).' },
          data.authThreadId,
          data.responseKeyId,
        );
      },
    );
    const sendMessage = vi.fn(async () => undefined);
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next: unknown) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage,
    };
    registerRuntimeLiveStopMessageAction(
      channelWiring as never,
      {
        getConversationRoutes: () => ({
          'sl:C123': { folder: 'main_agent' },
        }),
      } as never,
      { stopGroup: vi.fn() },
    );
    await handler?.({
      kind: 'scheduler_pause_job',
      conversationJid: 'sl:C123',
      userId: 'U123',
      jobId: 'job-1',
    });
    expect(processTaskIpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'scheduler_pause_job', jobId: 'job-1' }),
      'main_agent',
      expect.anything(),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Scheduler job paused (job-1).',
      expect.objectContaining({ durability: 'required' }),
    );
    // A non-approver tap never reaches the scheduler.
    processTaskIpcMock.mockClear();
    channelWiring.isControlApproverAllowed.mockResolvedValueOnce(
      false as never,
    );
    await handler?.({
      kind: 'scheduler_pause_job',
      conversationJid: 'sl:C123',
      userId: 'U999',
      jobId: 'job-1',
    });
    expect(processTaskIpcMock).not.toHaveBeenCalled();
  });

  it('host card taps present verifiable interactive provenance to the mutation-authority gate', async () => {
    let observed: {
      data?: Record<string, unknown>;
      restriction?: unknown;
      responseKeyId?: string;
    } = {};
    processTaskIpcMock.mockImplementation(
      async (
        data: {
          taskId?: string;
          authThreadId?: string;
          responseKeyId?: string;
        },
        sourceAgentFolder: string,
      ) => {
        observed = {
          data: data as Record<string, unknown>,
          responseKeyId: data.responseKeyId,
          restriction: data.responseKeyId
            ? permissionRunRestriction({
                sourceAgentFolder,
                responseKeyId: data.responseKeyId,
              })
            : undefined,
        };
        writeTaskIpcResponse(
          sourceAgentFolder,
          data.taskId,
          { ok: true, message: 'queued' },
          data.authThreadId,
          data.responseKeyId,
        );
      },
    );
    let handler: any;
    const channelWiring = {
      setMessageActionHandler: vi.fn((next: unknown) => {
        handler = next;
      }),
      isControlApproverAllowed: vi.fn(async () => true),
      sendMessage: vi.fn(async () => undefined),
    };
    registerRuntimeLiveStopMessageAction(
      channelWiring as never,
      {
        getConversationRoutes: () => ({
          'sl:C123': { folder: 'main_agent' },
        }),
      } as never,
      { stopGroup: vi.fn() },
    );
    await handler?.({
      kind: 'scheduler_retry_ask',
      conversationJid: 'sl:C123',
      userId: 'U123',
      jobId: 'job-1',
    });
    // The gate compares data.sourceRun* against the restriction registered for
    // (sourceAgentFolder, responseKeyId); both sides must exist and match.
    expect(observed.data).toMatchObject({
      sourceRunKind: 'interactive',
      sourceJobId: 'job-1',
    });
    expect(observed.data?.sourceRunId).toBe(observed.data?.taskId);
    expect(observed.restriction).toMatchObject({
      runKind: 'interactive',
      jobId: 'job-1',
      runId: observed.data?.taskId,
    });
    // The one-task restriction is unregistered once the tap settles.
    expect(
      permissionRunRestriction({
        sourceAgentFolder: 'main_agent',
        responseKeyId: observed.responseKeyId as string,
      }),
    ).toBeUndefined();
  });
});
