import { describe, expect, it } from 'vitest';

import {
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from '@core/jobs/execution-context.js';
import type { Job, RegisteredGroup } from '@core/domain/types.js';

function group(folder: string, name: string): RegisteredGroup {
  return {
    folder,
    name,
    trigger: '',
    requiresTrigger: false,
    isMain: false,
    conversationKind: 'channel',
  } as RegisteredGroup;
}

function job(input: Partial<Job>): Job {
  return {
    id: 'job-1',
    name: 'Job',
    prompt: 'Run',
    model: null,
    script: null,
    schedule_type: 'once',
    schedule_value: '',
    linked_sessions: [],
    session_id: null,
    thread_id: null,
    group_scope: 'agent-folder',
    created_by: 'agent',
    status: 'active',
    next_run: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...input,
  } as Job;
}

describe('resolveExecutionContext', () => {
  it('uses linked session conversations before folder fallback', () => {
    const groups = {
      'chat-a': group('agent-folder', 'Conversation A'),
      'chat-b': group('agent-folder', 'Conversation B'),
    };

    const resolved = resolveExecutionContext(
      job({ linked_sessions: ['chat-b'], group_scope: 'agent-folder' }),
      groups,
    );

    expect(resolved).toMatchObject({
      group: groups['chat-b'],
      executionJid: 'chat-b',
      stopAliasJids: ['chat-b'],
    });
  });

  it('falls back to the first folder match only when no linked session exists', () => {
    const groups = { 'chat-a': group('agent-folder', 'Conversation A') };

    const resolved = resolveExecutionContext(
      job({ linked_sessions: [], group_scope: 'agent-folder' }),
      groups,
    );

    expect(resolved).toMatchObject({
      group: groups['chat-a'],
      executionJid: 'chat-a',
      stopAliasJids: ['chat-a'],
    });
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
