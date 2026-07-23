import { describe, expect, it } from 'vitest';

import { resolveDeepAgentsPromptCache } from '@core/adapters/llm/deepagents-langchain/prompt-cache.js';
import { resolveModelSelection } from '@core/shared/model-catalog.js';

function cacheableModel() {
  const resolved = resolveModelSelection('grok');
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.entry;
}

describe('resolveDeepAgentsPromptCache', () => {
  it('partitions a conversation prompt cache by the provider access fingerprint', () => {
    const common = {
      modelEntry: cacheableModel(),
      conversationId: 'conversation-1',
      threadId: 'thread-a',
    };
    const first = resolveDeepAgentsPromptCache({
      ...common,
      accessFingerprint: 'provider-session-access:v2:first',
    });
    const same = resolveDeepAgentsPromptCache({
      ...common,
      accessFingerprint: 'provider-session-access:v2:first',
    });
    const changed = resolveDeepAgentsPromptCache({
      ...common,
      accessFingerprint: 'provider-session-access:v2:changed',
    });

    expect(first.promptCacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(same.promptCacheKey).toBe(first.promptCacheKey);
    expect(changed.promptCacheKey).not.toBe(first.promptCacheKey);
  });
});
