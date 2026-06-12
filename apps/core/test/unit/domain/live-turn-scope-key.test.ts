import { describe, expect, it } from 'vitest';

import {
  isTerminalLiveTurnState,
  makeLiveTurnScopeKey,
} from '@core/domain/ports/live-turns.js';

describe('makeLiveTurnScopeKey', () => {
  it('is deterministic for an identical scope', () => {
    const scope = {
      appId: 'default',
      agentSessionId: 'session-1',
      conversationId: 'group1@g.us',
      threadId: 'thread-9',
    };
    expect(makeLiveTurnScopeKey(scope)).toBe(makeLiveTurnScopeKey(scope));
  });

  it('normalizes null, undefined, and blank optional components to one key', () => {
    const base = { appId: 'default', conversationId: 'group1@g.us' };
    const keys = [
      makeLiveTurnScopeKey(base),
      makeLiveTurnScopeKey({ ...base, threadId: null }),
      makeLiveTurnScopeKey({ ...base, threadId: undefined }),
      makeLiveTurnScopeKey({ ...base, threadId: '' }),
      makeLiveTurnScopeKey({ ...base, threadId: '   ' }),
      makeLiveTurnScopeKey({ ...base, agentSessionId: null, threadId: null }),
    ];
    expect(new Set(keys).size).toBe(1);
  });

  it('separates scopes that differ in exactly one component', () => {
    const base = {
      appId: 'default',
      agentSessionId: 'session-1',
      conversationId: 'group1@g.us',
      threadId: 'thread-1',
    };
    const variants = [
      makeLiveTurnScopeKey(base),
      makeLiveTurnScopeKey({ ...base, appId: 'other' }),
      makeLiveTurnScopeKey({ ...base, agentSessionId: 'session-2' }),
      makeLiveTurnScopeKey({ ...base, conversationId: 'group2@g.us' }),
      makeLiveTurnScopeKey({ ...base, threadId: 'thread-2' }),
      makeLiveTurnScopeKey({ ...base, threadId: null }),
    ];
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('cannot be collided by delimiter characters inside ids', () => {
    // A conversation id crafted to look like it carries a thread component
    // must not equal the genuinely thread-scoped key.
    const crafted = makeLiveTurnScopeKey({
      appId: 'default',
      conversationId: 'group1@g.us|thread:t-1',
    });
    const genuine = makeLiveTurnScopeKey({
      appId: 'default',
      conversationId: 'group1@g.us',
      threadId: 't-1',
    });
    expect(crafted).not.toBe(genuine);

    const colonCrafted = makeLiveTurnScopeKey({
      appId: 'default:session:s1',
      conversationId: 'c1',
    });
    const colonGenuine = makeLiveTurnScopeKey({
      appId: 'default',
      agentSessionId: 's1',
      conversationId: 'c1',
    });
    expect(colonCrafted).not.toBe(colonGenuine);
  });
});

describe('isTerminalLiveTurnState', () => {
  it('classifies terminal and non-terminal states', () => {
    expect(isTerminalLiveTurnState('completed')).toBe(true);
    expect(isTerminalLiveTurnState('failed')).toBe(true);
    expect(isTerminalLiveTurnState('timed_out')).toBe(true);
    expect(isTerminalLiveTurnState('claimed')).toBe(false);
    expect(isTerminalLiveTurnState('running')).toBe(false);
    expect(isTerminalLiveTurnState('awaiting_interaction')).toBe(false);
    expect(isTerminalLiveTurnState('setup_required')).toBe(false);
    expect(isTerminalLiveTurnState('recovered')).toBe(false);
  });
});
