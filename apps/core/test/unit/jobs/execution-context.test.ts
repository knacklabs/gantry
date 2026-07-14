import { describe, expect, it } from 'vitest';

import {
  buildExecutionTurnContextInput,
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from '@core/jobs/execution-context.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';
import type { Job, ConversationRoute } from '@core/domain/types.js';

function group(
  folder: string,
  name: string,
  providerAccountId?: string,
): ConversationRoute {
  return {
    folder,
    name,
    trigger: '',
    requiresTrigger: false,
    conversationKind: 'channel',
    providerAccountId,
  } as ConversationRoute;
}

function job(input: Partial<Job>): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run',
    model: null,
    schedule_type: 'once',
    schedule_value: '',
    session_id: null,
    thread_id: null,
    workspace_key: 'agent-folder',
    created_by: 'agent',
    status: 'active',
    next_run: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...input,
  } as Job;
}

describe('resolveExecutionContext', () => {
  it('resolves execution using canonical execution_context', () => {
    const groups = {
      'chat-a': group('agent-folder', 'Conversation A'),
      'chat-b': group('agent-folder', 'Conversation B'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: 'agent-folder',
        execution_context: {
          conversationJid: 'chat-b',
          threadId: 'thread-1',
          workspaceKey: 'agent-folder',
        },
        notification_routes: [
          { conversationJid: 'chat-a', threadId: null, label: 'backup' },
          { conversationJid: 'chat-b', threadId: 'thread-1', label: 'primary' },
        ],
      }),
      groups,
    );

    expect(resolved).toMatchObject({
      group: groups['chat-b'],
      executionJid: 'chat-b',
      threadId: 'thread-1',
      stopAliasJids: ['chat-b', 'chat-a'],
    });
  });

  it('uses the same-conversation notification route thread for delivery when the job is conversation-owned', () => {
    const groups = {
      'chat-a': group('agent-folder', 'Conversation A'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: 'agent-folder',
        execution_context: {
          conversationJid: 'chat-a',
          threadId: null,
          workspaceKey: 'agent-folder',
        },
        notification_routes: [
          {
            conversationJid: 'chat-a',
            threadId: 'topic-2771',
            label: 'primary',
          },
        ],
      }),
      groups,
    );

    expect(resolved).toMatchObject({
      group: groups['chat-a'],
      executionJid: 'chat-a',
      threadId: 'topic-2771',
      stopAliasJids: ['chat-a'],
    });
  });

  it('resolves a provider conversation through the unique agent-qualified route', () => {
    const routeKey = makeAgentThreadQueueKey('sl:C123', 'agent:main_agent');
    const groups = {
      [routeKey]: group('main_agent', 'Main Agent'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: 'main_agent',
        execution_context: {
          conversationJid: 'sl:C123',
          threadId: null,
          workspaceKey: 'main_agent',
        },
        notification_routes: [
          { conversationJid: 'sl:C123', threadId: null, label: 'primary' },
        ],
      }),
      groups,
    );

    expect(resolved).toMatchObject({
      group: groups[routeKey],
      executionJid: 'sl:C123',
      threadId: null,
      stopAliasJids: ['sl:C123'],
    });
  });

  it('uses execution_context agentId to select the provider conversation route', () => {
    const alphaRouteKey = makeAgentThreadQueueKey('sl:C123', 'agent:alpha');
    const betaRouteKey = makeAgentThreadQueueKey('sl:C123', 'agent:beta');
    const groups = {
      [alphaRouteKey]: group('alpha', 'Alpha'),
      [betaRouteKey]: group('beta', 'Beta'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: 'alpha',
        execution_context: {
          conversationJid: 'sl:C123',
          threadId: null,
          workspaceKey: 'alpha',
          agentId: 'agent:beta',
        } as Job['execution_context'],
        notification_routes: [
          { conversationJid: 'sl:C123', threadId: null, label: 'primary' },
        ],
      }),
      groups,
    );

    expect(resolved?.group).toBe(groups[betaRouteKey]);
  });

  it('derives the route agent from the job workspace key', () => {
    const groups = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: group(
        'alpha',
        'Alpha',
      ),
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta')]: group('beta', 'Beta'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: 'alpha',
        execution_context: {
          conversationJid: 'sl:C123',
          threadId: null,
          workspaceKey: 'alpha',
        },
        notification_routes: [
          { conversationJid: 'sl:C123', threadId: null, label: 'primary' },
        ],
      }),
      groups,
    );

    expect(resolved?.group).toBe(
      groups[makeAgentThreadQueueKey('sl:C123', 'agent:alpha')],
    );
  });

  it('uses the notification route provider account to select execution route', () => {
    const alphaKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      null,
      'acct-a',
    );
    const betaKey = makeAgentThreadQueueKey(
      'sl:C123',
      'agent:alpha',
      null,
      'acct-b',
    );
    const groups = {
      [alphaKey]: group('alpha', 'Alpha A', 'acct-a'),
      [betaKey]: group('alpha', 'Alpha B', 'acct-b'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: 'alpha',
        execution_context: {
          conversationJid: 'sl:C123',
          threadId: null,
          workspaceKey: 'alpha',
        },
        notification_routes: [
          {
            conversationJid: 'sl:C123',
            threadId: null,
            providerAccountId: 'acct-b',
            label: 'primary',
          },
        ],
      }),
      groups,
    );

    expect(resolved?.group).toBe(groups[betaKey]);
  });

  it('returns null for ambiguous provider conversation routes without a job agent', () => {
    const groups = {
      [makeAgentThreadQueueKey('sl:C123', 'agent:alpha')]: group(
        'alpha',
        'Alpha',
      ),
      [makeAgentThreadQueueKey('sl:C123', 'agent:beta')]: group('beta', 'Beta'),
    };

    const resolved = resolveExecutionContext(
      job({
        workspace_key: '',
        execution_context: {
          conversationJid: 'sl:C123',
          threadId: null,
        } as Job['execution_context'],
        notification_routes: [
          { conversationJid: 'sl:C123', threadId: null, label: 'primary' },
        ],
      }),
      groups,
    );

    expect(resolved).toBeNull();
  });

  it('returns null without canonical execution context', () => {
    const groups = { 'chat-a': group('agent-folder', 'Conversation A') };

    const resolved = resolveExecutionContext(
      job({ workspace_key: 'agent-folder' }),
      groups,
    );

    expect(resolved).toBeNull();
  });

  it('returns null when execution conversation is not bound in runtime routes', () => {
    const groups = { 'chat-a': group('agent-folder', 'Conversation A') };

    const resolved = resolveExecutionContext(
      job({
        execution_context: {
          conversationJid: 'chat-missing',
          threadId: null,
          workspaceKey: 'agent-folder',
        },
        notification_routes: [
          { conversationJid: 'chat-a', threadId: null, label: 'backup' },
        ],
      }),
      groups,
    );

    expect(resolved).toBeNull();
  });
});

describe('resolveExecutionMemoryContext', () => {
  it('uses user memory for direct job execution contexts', () => {
    expect(
      resolveExecutionMemoryContext({
        conversationKind: 'dm',
        executionJid: 'tg:575',
      }),
    ).toEqual({
      memoryDefaultScope: 'user',
      memoryUserId: 'tg:575',
    });
  });

  it('uses group memory for channel job execution contexts', () => {
    expect(
      resolveExecutionMemoryContext({
        conversationKind: 'channel',
        executionJid: 'tg:-100',
      }),
    ).toEqual({ memoryDefaultScope: 'group' });
  });
});

describe('buildExecutionTurnContextInput', () => {
  it('passes first-run DM scheduled context with trusted memory user id', () => {
    expect(
      buildExecutionTurnContextInput({
        agentFolder: 'team-folder',
        executionJid: 'tg:575',
        threadId: null,
        conversationKind: 'dm',
        memoryUserId: 'tg:575',
        query: 'Summarize direct context',
      }),
    ).toEqual({
      agentFolder: 'team-folder',
      conversationJid: 'tg:575',
      threadId: null,
      conversationKind: 'dm',
      memoryUserId: 'tg:575',
      query: 'Summarize direct context',
    });
  });

  it('passes first-run channel scheduled context without user override', () => {
    expect(
      buildExecutionTurnContextInput({
        agentFolder: 'team-folder',
        executionJid: 'sl:C123',
        threadId: 'thread-1',
        conversationKind: 'channel',
        query: 'Summarize channel thread',
      }),
    ).toEqual({
      agentFolder: 'team-folder',
      conversationJid: 'sl:C123',
      threadId: 'thread-1',
      conversationKind: 'channel',
      memoryUserId: undefined,
      query: 'Summarize channel thread',
    });
  });

  it('bounds and cleans scheduled prompt recall queries', () => {
    const noisyPrompt = `<context timezone="UTC" />
<messages>
<message sender="User" time="today">${Array.from(
      { length: 140 },
      (_, index) => `term${index}`,
    ).join(' ')}</message>
</messages>`;

    const result = buildExecutionTurnContextInput({
      agentFolder: 'team-folder',
      executionJid: 'sl:C123',
      threadId: null,
      conversationKind: 'channel',
      query: noisyPrompt,
    });

    expect(result.query).not.toContain('<message');
    expect(result.query).not.toContain('timezone=');
    expect(result.query?.split(/\s+/)).toHaveLength(80);
    expect(result.query?.length).toBeLessThanOrEqual(1200);
  });
});
