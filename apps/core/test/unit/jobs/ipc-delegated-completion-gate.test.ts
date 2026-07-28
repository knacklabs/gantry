import { describe, expect, it, vi } from 'vitest';

import { createInheritedDelegatedAgentRunner } from '@core/jobs/ipc-delegated-task-support.js';

describe('delegated completion gate projection', () => {
  it('projects the gate only into configured delegated task keys', async () => {
    const runAgent = vi.fn(async () => ({
      status: 'success' as const,
      result: 'done',
    }));
    const runner = await createInheritedDelegatedAgentRunner({
      context: {
        data: { jobId: 'job-1', runId: 'run-1' },
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
                  maxInteractions: 8,
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
          runAgent,
        },
      } as never,
      owner: {
        appId: 'app:test',
        agentId: 'agent:parent',
        conversationId: 'conversation-1',
      } as never,
      target: {
        group: { folder: 'tender', agentConfig: {} },
        targetOwner: {
          appId: 'app:test',
          agentId: 'agent:child',
        },
        targetAgentId: 'agent:child',
        toolPolicy: { toolPolicyRules: [], runtimeAccess: [] },
        selectedSkillContext: { ids: [], displays: [] },
        semanticCapabilities: [],
        attachedMcpSourceIds: [],
      } as never,
    });
    const runTask = (taskKey: string) =>
      runner({
        task: {
          id: `task-${taskKey}`,
          privateCorrelationJson: { taskKey },
        },
        prompt: 'Research.',
        signal: new AbortController().signal,
      } as never);

    await runTask('research-one');
    await runTask('reviewer');

    expect(runAgent.mock.calls[0]?.[1]).toMatchObject({
      delegatedCompletionGate: {
        toolName: 'validate_completion',
        maxNoProgressContinuations: 2,
        interactionTimeoutMs: 90_000,
      },
    });
    expect(runAgent.mock.calls[1]?.[1]).not.toHaveProperty(
      'delegatedCompletionGate',
    );
  });
});
