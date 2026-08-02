import { describe, expect, it, vi } from 'vitest';

import {
  buildCurrentScopeResetMatcher,
  PostgresCanonicalSessionRepository,
} from '@core/adapters/storage/postgres/repositories/canonical-session-repository.postgres.js';

describe('buildCurrentScopeResetMatcher', () => {
  it('includes descendant patterns for bare group scope resets', () => {
    const matcher = buildCurrentScopeResetMatcher('main');

    expect(matcher).toEqual({
      currentScopeExact: 'main',
      currentScopeDescendantLike: 'main::%',
    });
  });

  it('keeps scoped conversation/thread resets exact (no descendant wildcard)', () => {
    const matcher = buildCurrentScopeResetMatcher(
      'main::conversation:sl%3AC-A::thread:111.222',
    );

    expect(matcher).toEqual({
      currentScopeExact: 'main::conversation:sl%3AC-A::thread:111.222',
    });
  });

  it('keeps scoped dm resets exact (no descendant wildcard)', () => {
    const matcher = buildCurrentScopeResetMatcher(
      'main::conversation:sl%3AD-1::user:U123',
    );

    expect(matcher).toEqual({
      currentScopeExact: 'main::conversation:sl%3AD-1::user:U123',
    });
  });
});

describe('PostgresCanonicalSessionRepository thread route', () => {
  it('passes the exact ensured conversation id into ensureThread', async () => {
    const ensureConversation = vi.fn(async () => 'conversation:exact');
    const ensureThread = vi.fn(async () => 'thread:exact');
    const repository = new PostgresCanonicalSessionRepository({} as never);
    const internals = repository as unknown as {
      graph: { ensureConversation: typeof ensureConversation; ensureThread: typeof ensureThread };
      resolveBoundAgentId: () => Promise<string>;
      resolveSessionRoute: (
        input: {
          appId: string;
          folder: string;
          chatJid: string;
          providerAccountId: string;
          threadId: string;
          conversationKind: 'channel';
        },
        executor: unknown,
      ) => Promise<unknown>;
    };
    internals.graph = { ensureConversation, ensureThread };
    internals.resolveBoundAgentId = vi.fn(async () => 'agent:main');
    const executor = {};

    await internals.resolveSessionRoute(
      {
        appId: 'default',
        folder: 'main',
        chatJid: 'sl:C123',
        providerAccountId: 'slack_account',
        threadId: '1710000000.000100',
        conversationKind: 'channel',
      },
      executor,
    );

    expect(ensureThread).toHaveBeenCalledWith(
      'sl:C123',
      '1710000000.000100',
      executor,
      {
        conversationId: 'conversation:exact',
        providerAccountId: 'slack_account',
      },
    );
  });
});
