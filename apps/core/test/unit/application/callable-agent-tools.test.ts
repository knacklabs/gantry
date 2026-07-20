import { describe, expect, it, vi } from 'vitest';

import {
  CALLABLE_AGENT_TOOL_PREFIX,
  conversationBoundAgentIdsForRoute,
  conversationBoundAgentRoute,
  dispatchCallableAgentTool,
  projectCallableAgentTools,
} from '@core/application/core-tools/callable-agent-tools.js';
import type { Agent } from '@core/domain/agent/agent.js';
import type { CoreTaskLifecycleBackend } from '@core/application/core-tools/task-lifecycle.js';
import type { CoreSendMessageDeps } from '@core/application/core-tools/send-message.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

function agent(
  id: string,
  options: Partial<Pick<Agent, 'appId' | 'name' | 'status'>> = {},
): Agent {
  return {
    id,
    appId: options.appId ?? 'default',
    name: options.name ?? id,
    status: options.status ?? 'active',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as Agent;
}

function backend(): CoreTaskLifecycleBackend {
  return {
    owner: {
      appId: 'default',
      agentId: 'agent:main_agent',
      conversationId: 'conversation:origin',
      providerAccountId: 'slack_beta',
      threadId: 'thread-1',
    },
    delegate_task: vi.fn(async () => ({ ok: true, message: 'queued' })),
    task_get: vi.fn(),
    task_list: vi.fn(),
    task_cancel: vi.fn(),
    task_message: vi.fn(),
  } as CoreTaskLifecycleBackend;
}

function narration(
  sendMessage: CoreSendMessageDeps['sendMessage'],
  warn = vi.fn(),
) {
  return {
    sourceAgentFolder: 'main_agent',
    deps: { sendMessage, warn },
  };
}

describe('callable agent tools', () => {
  it('derives bound agents from live canonical routes across provider accounts', () => {
    const route = (
      agentId: string,
      providerAccountId: string,
      conversationId?: string,
    ) => ({
      name: agentId,
      folder: agentId.slice('agent:'.length),
      agentId,
      providerAccountId,
      conversationId,
      trigger: '@gantry',
      added_at: new Date(0).toISOString(),
    });
    const routes = {
      [makeAgentThreadQueueKey(
        'slack:C1',
        'agent:main_agent',
        undefined,
        'slack-main',
      )]: route('agent:main_agent', 'slack-main', 'conversation:shared'),
      [makeAgentThreadQueueKey(
        'slack:C1',
        'agent:reviewer',
        undefined,
        'slack-reviewer',
      )]: route('agent:reviewer', 'slack-reviewer', 'conversation:shared'),
      [makeAgentThreadQueueKey(
        'slack:C1',
        'agent:foreign',
        undefined,
        'slack-foreign',
      )]: route('agent:foreign', 'slack-foreign', 'conversation:other'),
    };

    expect(
      conversationBoundAgentIdsForRoute({
        routes,
        chatJid: 'slack:C1',
        callerAgentId: 'agent:main_agent',
        callerProviderAccountId: 'slack-main',
      }),
    ).toEqual(new Set(['agent:main_agent', 'agent:reviewer']));
    expect(
      conversationBoundAgentRoute({
        routes,
        chatJid: 'slack:C1',
        callerAgentId: 'agent:main_agent',
        callerProviderAccountId: 'slack-main',
        targetAgentId: 'agent:reviewer',
      }),
    ).toMatchObject({
      agentId: 'agent:reviewer',
      providerAccountId: 'slack-reviewer',
      conversationId: 'conversation:shared',
    });
    expect(
      conversationBoundAgentIdsForRoute({
        routes: {
          caller: route('agent:main_agent', 'slack-main'),
        },
        chatJid: 'caller',
        callerAgentId: 'agent:main_agent',
        callerProviderAccountId: 'slack-main',
      }),
    ).toEqual(new Set());
  });

  it('projects only active same-app non-self allowlisted agents', () => {
    const projected = projectCallableAgentTools({
      agents: [
        agent('agent:main_agent'),
        agent('agent:reviewer', { name: 'Review\nAgent' }),
        agent('agent:disabled', { status: 'disabled' }),
        agent('agent:other-app', { appId: 'other' }),
        agent('agent:unlisted'),
      ],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: [
        'reviewer',
        'agent:reviewer',
        'disabled',
        'other-app',
        'main_agent',
      ],
      conversationBoundAgentIds: new Set(['agent:reviewer']),
      personasByAgentId: { 'agent:reviewer': 'research' },
      toolPolicyRules: ['AgentDelegation'],
    });

    expect(projected).toEqual([
      expect.objectContaining({
        targetAgentId: 'agent:reviewer',
        displayName: 'Review Agent',
        persona: 'research',
      }),
    ]);
  });

  it('uses bounded collision-safe names derived from immutable identity', () => {
    const projected = projectCallableAgentTools({
      agents: [agent('agent:same-name-a'), agent('agent:same-name-b')],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: ['same-name-a', 'same-name-b'],
      conversationBoundAgentIds: new Set([
        'agent:same-name-a',
        'agent:same-name-b',
      ]),
      toolPolicyRules: ['AgentDelegation'],
    });

    expect(new Set(projected.map(({ toolName }) => toolName)).size).toBe(2);
    expect(
      projected.every(
        ({ toolName }) =>
          `mcp__gantry__${CALLABLE_AGENT_TOOL_PREFIX}${toolName}`.length <= 64,
      ),
    ).toBe(true);
  });

  it('bounds projected display names for every worker lane', () => {
    const projected = projectCallableAgentTools({
      agents: [agent('agent:reviewer', { name: `  ${'R'.repeat(240)}  ` })],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: ['reviewer'],
      conversationBoundAgentIds: new Set(['agent:reviewer']),
      toolPolicyRules: ['AgentDelegation'],
    });

    expect(projected[0]?.displayName).toHaveLength(200);

    const fallback = projectCallableAgentTools({
      agents: [agent('agent:reviewer', { name: '   ' })],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: ['reviewer'],
      conversationBoundAgentIds: new Set(['agent:reviewer']),
      toolPolicyRules: ['AgentDelegation'],
    });
    expect(fallback[0]?.displayName).toBe('reviewer');
  });

  it.each([
    { parentTaskId: 'task-parent', toolPolicyRules: ['AgentDelegation'] },
    { parentTaskId: undefined, toolPolicyRules: [] },
  ])('suppresses projection without top-level delegation authority', (run) => {
    expect(
      projectCallableAgentTools({
        agents: [agent('agent:reviewer')],
        callerAppId: 'default',
        callerAgentId: 'agent:main_agent',
        callerFolder: 'main_agent',
        delegates: ['reviewer'],
        conversationBoundAgentIds: new Set(['agent:reviewer']),
        ...run,
      }),
    ).toEqual([]);
  });

  it('omits active delegates not bound to the conversation without warning', () => {
    const warn = vi.fn();

    expect(
      projectCallableAgentTools({
        agents: [agent('agent:reviewer')],
        callerAppId: 'default',
        callerAgentId: 'agent:main_agent',
        callerFolder: 'main_agent',
        delegates: ['reviewer'],
        conversationBoundAgentIds: new Set(),
        toolPolicyRules: ['AgentDelegation'],
        warn,
      }),
    ).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per unresolved delegate ref per projection with bounded context', () => {
    const warn = vi.fn();
    const longMissingRef = `missing-${'x'.repeat(200)}`;

    projectCallableAgentTools({
      agents: [],
      callerAppId: 'default',
      callerAgentId: 'agent:main_agent',
      callerFolder: 'main_agent',
      delegates: [longMissingRef, longMissingRef, 'typo'],
      conversationBoundAgentIds: new Set(),
      toolPolicyRules: ['AgentDelegation'],
      warn,
    });

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map(([context]) => context.delegateRef)).toEqual([
      longMissingRef.slice(0, 160),
      'typo',
    ]);
  });

  it('injects the pinned target after current eligibility revalidation', async () => {
    const taskBackend = backend();
    const revalidate = vi.fn(async () => true);
    const entry = {
      toolName: 'reviewer_hash',
      targetAgentId: 'agent:reviewer',
      displayName: 'Reviewer',
      persona: 'research' as const,
    };

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this', timeoutMs: 1234 },
        entry,
        backend: taskBackend,
        revalidate,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(taskBackend.delegate_task).toHaveBeenCalledWith({
      objective: 'Review this',
      timeoutMs: 1234,
      syncWaitTimeoutMs: 60_000,
      targetAgentId: 'agent:reviewer',
    });
  });

  it('narrates the objective at delegation start and sync completion', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue({
      ok: true,
      message: 'Specialist result',
      data: { status: 'completed' },
    });

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
          persona: 'research',
        },
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
        narration: narration(sendMessage),
      }),
    ).resolves.toEqual({
      ok: true,
      message: 'Specialist result',
      data: { status: 'completed' },
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'conversation:origin',
      'Checking with the Reviewer agent about: Review this…',
      expect.objectContaining({
        providerAccountId: 'slack_beta',
        threadId: 'thread-1',
      }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'conversation:origin',
      'Reviewer responded.',
      expect.objectContaining({
        providerAccountId: 'slack_beta',
        threadId: 'thread-1',
      }),
    );
  });

  it('suppresses narration for a scheduled run', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();

    await dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
        persona: 'research',
      },
      backend: taskBackend,
      revalidate: vi.fn(async () => true),
      narration: { ...narration(sendMessage), isScheduledJob: true },
    });

    expect(taskBackend.delegate_task).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('narrates the async fallback without posting a transcript', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue({
      ok: true,
      message: 'Queued: task-running',
      data: { taskId: 'task-running', status: 'running' },
    });

    await dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
        persona: 'research',
      },
      backend: taskBackend,
      revalidate: vi.fn(async () => true),
      narration: narration(sendMessage),
    });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      'Checking with the Reviewer agent about: Review this…',
      "Reviewer is still working; I'll follow up.",
    ]);
  });

  it('narrates a timed-out delegation failure reason', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    const delegatedResult = {
      ok: false,
      message: 'Delegated agent timed out.',
      code: 'unavailable' as const,
      data: { taskId: 'task-timeout', status: 'timed_out' },
    };
    vi.mocked(taskBackend.delegate_task).mockResolvedValue(delegatedResult);

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
          persona: 'research',
        },
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
        narration: narration(sendMessage),
      }),
    ).resolves.toBe(delegatedResult);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      'Checking with the Reviewer agent about: Review this…',
      'Delegation to Reviewer failed: Delegated agent timed out.',
    ]);
  });

  it('redacts and bounds objective and failure narration snippets', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    const objectiveMarker = 'objective-marker-value';
    const failureMarker = 'failure-marker-value';
    vi.mocked(taskBackend.delegate_task).mockResolvedValue({
      ok: false,
      message: `password=${failureMarker} ${'f'.repeat(300)}`,
      code: 'unavailable',
    });

    await dispatchCallableAgentTool({
      args: {
        objective: `api_key=${objectiveMarker} ${'o'.repeat(300)}`,
      },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
        persona: 'research',
      },
      backend: taskBackend,
      revalidate: vi.fn(async () => true),
      narration: narration(sendMessage),
    });

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    const narrationTexts = sendMessage.mock.calls.map(([, text]) => text);
    expect(narrationTexts.join('\n')).not.toContain(objectiveMarker);
    expect(narrationTexts.join('\n')).not.toContain(failureMarker);
    expect(narrationTexts).toEqual([
      expect.stringContaining('api_key=[REDACTED_SECRET]'),
      expect.stringContaining('password=[REDACTED_SECRET]'),
    ]);
    expect(narrationTexts[0]!.length).toBeLessThanOrEqual(202);
    expect(narrationTexts[1]!.length).toBeLessThanOrEqual(191);
  });

  it('warns and keeps delegation fail-open when narration delivery rejects', async () => {
    const sendMessage = vi.fn(async () => {
      throw new Error('delivery unavailable');
    });
    const warn = vi.fn();
    const delegatedResult = {
      ok: true,
      message: 'Specialist result',
      data: { taskId: 'task-1', status: 'completed' },
    };
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue(delegatedResult);

    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
          persona: 'research',
        },
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
        narration: narration(sendMessage, warn),
      }),
    ).resolves.toBe(delegatedResult);
    expect(taskBackend.delegate_task).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ error: 'delivery unavailable' }),
      'Callable-agent narration delivery failed',
    );
  });

  it('bounds start narration before delegating when delivery stalls', async () => {
    vi.useFakeTimers();
    const sendMessage = vi.fn(() => new Promise<void>(() => {}));
    const warn = vi.fn();
    const delegatedResult = {
      ok: true,
      message: 'Specialist result',
    };
    const taskBackend = backend();
    vi.mocked(taskBackend.delegate_task).mockResolvedValue(delegatedResult);
    const revalidate = vi.fn(async () => true);

    try {
      const dispatched = dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry: {
          toolName: 'reviewer_hash',
          targetAgentId: 'agent:reviewer',
          displayName: 'Reviewer',
          persona: 'research',
        },
        backend: taskBackend,
        revalidate,
        narration: narration(sendMessage, warn),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(revalidate).toHaveBeenCalledOnce();
      expect(taskBackend.delegate_task).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);

      expect(revalidate).toHaveBeenCalledOnce();
      expect(taskBackend.delegate_task).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(revalidate).toHaveBeenCalledTimes(2);
      expect(taskBackend.delegate_task).toHaveBeenCalledOnce();
      expect(revalidate.mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(taskBackend.delegate_task).mock.invocationCallOrder[0]!,
      );
      await expect(dispatched).resolves.toBe(delegatedResult);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ error: 'Narration delivery timed out.' }),
        'Callable-agent narration delivery failed',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not narrate a rejected call that never delegates', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();

    await dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
        persona: 'research',
      },
      backend: taskBackend,
      revalidate: vi.fn(async () => false),
      narration: narration(sendMessage),
    });

    expect(taskBackend.delegate_task).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not delegate when eligibility is revoked immediately before dispatch', async () => {
    let resolveRevalidation!: (eligible: boolean) => void;
    const finalRevalidation = new Promise<boolean>((resolve) => {
      resolveRevalidation = resolve;
    });
    const sendMessage = vi.fn(async () => undefined);
    const taskBackend = backend();
    const revalidate = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => finalRevalidation);

    const dispatched = dispatchCallableAgentTool({
      args: { objective: 'Review this' },
      entry: {
        toolName: 'reviewer_hash',
        targetAgentId: 'agent:reviewer',
        displayName: 'Reviewer',
        persona: 'research',
      },
      backend: taskBackend,
      revalidate,
      narration: narration(sendMessage),
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    expect(taskBackend.delegate_task).not.toHaveBeenCalled();

    resolveRevalidation(false);

    await expect(dispatched).resolves.toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(revalidate).toHaveBeenCalledTimes(2);
    expect(taskBackend.delegate_task).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage.mock.calls.map(([, text]) => text)).toEqual([
      'Checking with the Reviewer agent about: Review this…',
      'Reviewer is no longer available.',
    ]);
  });

  it('rejects target overrides and stale target eligibility', async () => {
    const taskBackend = backend();
    const entry = {
      toolName: 'reviewer_hash',
      targetAgentId: 'agent:reviewer',
      displayName: 'Reviewer',
      persona: 'research' as const,
    };

    await expect(
      dispatchCallableAgentTool({
        args: {
          objective: 'Review this',
          targetAgentId: 'agent:attacker',
        },
        entry,
        backend: taskBackend,
        revalidate: vi.fn(async () => true),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
    await expect(
      dispatchCallableAgentTool({
        args: { objective: 'Review this' },
        entry,
        backend: taskBackend,
        revalidate: vi.fn(async () => false),
      }),
    ).resolves.toMatchObject({ ok: false, code: 'forbidden' });
    expect(taskBackend.delegate_task).not.toHaveBeenCalled();
  });
});
