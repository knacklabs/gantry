import { describe, expect, it } from 'vitest';

import {
  buildExecutionTurnContextInput,
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from '@core/jobs/execution-context.js';
import type { Job, ConversationRoute } from '@core/domain/types.js';

function group(folder: string, name: string): ConversationRoute {
  return {
    folder,
    name,
    trigger: '',
    requiresTrigger: false,
    conversationKind: 'channel',
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
