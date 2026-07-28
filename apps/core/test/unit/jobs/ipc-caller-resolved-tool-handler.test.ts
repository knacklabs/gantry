import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestCallerResolvedTool } = vi.hoisted(() => ({
  requestCallerResolvedTool: vi.fn(),
}));

vi.mock(
  '@core/application/interactions/caller-resolved-tool-coordinator.js',
  () => ({ requestCallerResolvedTool }),
);

import { createCallerResolvedToolHandler } from '@core/jobs/ipc-caller-resolved-tool-handler.js';

describe('caller-resolved delegated completion gate', () => {
  beforeEach(() => {
    requestCallerResolvedTool.mockReset();
  });

  it('authorizes the hidden gate only for a configured delegated task key', async () => {
    const acceptData = vi.fn();
    const reject = vi.fn();
    const publishRuntimeEvent = vi.fn(async () => undefined);
    requestCallerResolvedTool.mockImplementation(
      async (input: { emitRequired: () => Promise<void> }) => {
        await input.emitRequired();
        return { decision: 'continue', progressToken: '11', message: 'next' };
      },
    );
    const handler = createCallerResolvedToolHandler({
      responder: () => ({ acceptData, reject }) as never,
      taskScope: () =>
        ({
          appId: 'app:test',
          agentId: 'agent:tender',
          conversationId: 'conversation-1',
          threadId: 'thread-1',
          sandboxPolicy: { correlationId: 'correlation-1' },
        }) as never,
    });

    await handler({
      sourceAgentFolder: 'tender',
      data: {
        runId: 'run-1',
        jobId: 'job-1',
        parentTaskId: 'task-1',
        payload: {
          toolName: 'validate_completion',
          toolInput: { completionAttempt: 1 },
        },
      },
      deps: {
        opsRepository: {
          getJobById: async () => ({
            session_id: 'session-1',
            agent_task: {
              callerResolvedTools: {
                tools: [
                  {
                    name: 'search',
                    description: 'search',
                    inputSchema: { type: 'object' },
                  },
                ],
                maxInteractions: 1,
                interactionTimeoutMs: 90_000,
              },
              delegatedCompletionGate: {
                toolName: 'validate_completion',
                taskKeys: ['research-one'],
                maxNoProgressContinuations: 2,
              },
              executionPolicy: { totalTimeoutMs: 120_000 },
            },
          }),
        },
        getAsyncTaskRepository: () => ({
          getTask: async () => ({
            privateCorrelationJson: { taskKey: 'research-one' },
          }),
        }),
        publishRuntimeEvent,
      },
    } as never);

    expect(reject).not.toHaveBeenCalled();
    expect(acceptData).toHaveBeenCalledWith(
      'Caller-resolved tool completed.',
      expect.objectContaining({ decision: 'continue' }),
    );
    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'interaction.pending',
        payload: expect.objectContaining({
          toolName: 'validate_completion',
          taskKey: 'research-one',
        }),
      }),
    );
  });

  it('authorizes a configured hidden root-job completion gate', async () => {
    const acceptData = vi.fn();
    const reject = vi.fn();
    requestCallerResolvedTool.mockResolvedValue({
      decision: 'accept',
      progressToken: 'coverage:complete',
    });
    const handler = createCallerResolvedToolHandler({
      responder: () => ({ acceptData, reject }) as never,
      taskScope: () =>
        ({
          appId: 'app:test',
          agentId: 'agent:tender',
          conversationId: 'conversation-1',
          threadId: null,
          sandboxPolicy: {},
        }) as never,
    });

    await handler({
      sourceAgentFolder: 'tender',
      data: {
        runId: 'run-1',
        jobId: 'job-1',
        payload: {
          toolName: 'validate_root_completion',
          toolInput: { completionAttempt: 1 },
        },
      },
      deps: {
        opsRepository: {
          getJobById: async () => ({
            session_id: 'session-1',
            agent_task: {
              callerResolvedTools: {
                tools: [
                  {
                    name: 'search',
                    description: 'search',
                    inputSchema: { type: 'object' },
                  },
                ],
                maxInteractions: 1,
                interactionTimeoutMs: 90_000,
              },
              completionGate: {
                toolName: 'validate_root_completion',
                maxNoProgressContinuations: 2,
              },
              executionPolicy: { totalTimeoutMs: 120_000 },
            },
          }),
        },
      },
    } as never);

    expect(reject).not.toHaveBeenCalled();
    expect(acceptData).toHaveBeenCalledWith(
      'Caller-resolved tool completed.',
      expect.objectContaining({ decision: 'accept' }),
    );
  });
});
