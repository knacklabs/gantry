import { describe, expect, it } from 'vitest';

import { patternSubjectForScope } from '@core/shared/pattern-candidate-subject.js';

describe('patternSubjectForScope', () => {
  it('keys DMs with an authenticated user by user id', () => {
    expect(
      patternSubjectForScope({
        appId: 'app',
        agentId: 'agent',
        folder: 'folder',
        conversationKind: 'dm',
        userId: 'user-123',
      }),
    ).toEqual({
      appId: 'app',
      agentId: 'agent',
      folder: 'folder',
      subjectType: 'user',
      subjectId: 'user-123',
    });
  });

  it('keys conversations with an id by canonical channel id', () => {
    expect(
      patternSubjectForScope({
        appId: 'app',
        agentId: 'agent',
        folder: 'folder',
        conversationKind: 'channel',
        conversationId: 'sl:C123',
      }),
    ).toEqual({
      appId: 'app',
      agentId: 'agent',
      folder: 'folder',
      subjectType: 'channel',
      subjectId: 'conversation:sl:C123',
    });
  });

  it('keys groups without a conversation id by folder', () => {
    expect(
      patternSubjectForScope({
        appId: 'app',
        agentId: 'agent',
        folder: 'group-folder',
      }),
    ).toEqual({
      appId: 'app',
      agentId: 'agent',
      folder: 'group-folder',
      subjectType: 'group',
      subjectId: 'group-folder',
    });
  });

  it('has no subject for DMs without an authenticated user', () => {
    expect(
      patternSubjectForScope({
        appId: 'app',
        agentId: 'agent',
        folder: 'folder',
        conversationKind: 'dm',
        conversationId: 'sl:C123',
      }),
    ).toBeNull();
  });

  it('is deterministic for the shared write/read keying tuple', () => {
    const scope = {
      appId: ' app ',
      agentId: ' agent ',
      folder: ' folder ',
      conversationKind: 'channel' as const,
      conversationId: 'conversation:sl:C999',
    };

    const subject = patternSubjectForScope(scope);
    expect(patternSubjectForScope(scope)).toEqual(subject);
    expect(subject).toEqual({
      appId: 'app',
      agentId: 'agent',
      folder: 'folder',
      subjectType: 'channel',
      subjectId: 'conversation:sl:C999',
    });
  });
});
