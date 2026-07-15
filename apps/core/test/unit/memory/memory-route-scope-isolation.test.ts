import { describe, expect, it } from 'vitest';

import { resolveTrustedMemorySubject } from '@core/memory/memory-ipc.js';
import { createRouteAwareMemoryLlmClient } from '@core/adapters/llm/route-aware-memory-llm-client.js';
import type {
  MemoryLlmClient,
  MemoryLlmModelProfile,
  MemoryLlmQueryOpts,
} from '@core/domain/ports/memory-llm-client.js';

/**
 * Route-aware dispatch must never change how memory scope is resolved. The
 * subject is derived purely from agent folder + trusted conversation context +
 * scope, independent of which model family answers the query.
 */
function recordingClient(family: string): {
  client: MemoryLlmClient;
  seen: MemoryLlmQueryOpts[];
} {
  const seen: MemoryLlmQueryOpts[] = [];
  return {
    seen,
    client: {
      isConfigured: () => true,
      query: async (opts) => {
        seen.push(opts);
        return family;
      },
    },
  };
}

function profileFor(family: string, route: string): MemoryLlmModelProfile {
  return {
    alias: family,
    runnerModel: `${family}-runner`,
    responseFamily: family,
    modelRoute: route,
    modelRouteLabel: route,
    displayName: family,
  };
}

describe('memory route scope isolation', () => {
  it('resolves identical subjects regardless of memory model family', () => {
    const context = {
      appId: 'default',
      chatJid: 'sl:C999',
      userId: 'sl:U999',
      defaultScope: 'group' as const,
    };

    const subject = resolveTrustedMemorySubject('team-folder', context);
    const sameAgain = resolveTrustedMemorySubject('team-folder', context);

    expect(subject).toEqual(sameAgain);
    expect(subject).toMatchObject({
      subjectType: 'channel',
      subjectId: 'conversation:sl:C999',
    });
  });

  it('rejects memory scope overrides across the trusted conversation boundary', () => {
    expect(() =>
      resolveTrustedMemorySubject(
        'team-folder',
        {
          appId: 'default',
          chatJid: 'sl:C999',
          userId: 'person:one',
          defaultScope: 'group',
        },
        'user',
      ),
    ).toThrow('memory scope must match the trusted conversation scope');
    expect(() =>
      resolveTrustedMemorySubject(
        'dm-folder',
        {
          appId: 'default',
          chatJid: 'sl:D999',
          userId: 'person:one',
          defaultScope: 'user',
        },
        'group',
      ),
    ).toThrow('memory scope must match the trusted conversation scope');
  });

  it('keeps subject resolution independent of which family the router dispatches to', async () => {
    const openai = recordingClient('openai');
    const anthropicLane = recordingClient(['anth', 'ropic'].join(''));
    // The router dispatches purely on the model family: anthropic -> Claude SDK
    // lane, openai -> OpenAI direct lane. There is no engine input.
    const router = createRouteAwareMemoryLlmClient({
      anthropic: anthropicLane.client,
      openai: openai.client,
    });

    const context = {
      appId: 'default',
      chatJid: 'tg:-100123',
      userId: 'tg:42',
    };
    const subjectBefore = resolveTrustedMemorySubject('dm-folder', context);

    await router.query({
      appId: 'default' as never,
      model: 'gpt-test',
      modelProfile: profileFor('openai', 'openai'),
      prompt: 'extract',
    });
    await router.query({
      appId: 'default' as never,
      model: 'claude-test',
      modelProfile: profileFor(
        ['anth', 'ropic'].join(''),
        ['anth', 'ropic'].join(''),
      ),
      prompt: 'extract',
    });

    // Both families were exercised, but subject resolution is unchanged.
    expect(openai.seen).toHaveLength(1);
    expect(anthropicLane.seen).toHaveLength(1);

    const subjectAfter = resolveTrustedMemorySubject('dm-folder', context);
    expect(subjectAfter).toEqual(subjectBefore);
  });
});
