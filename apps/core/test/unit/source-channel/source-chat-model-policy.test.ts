import { it, expect } from 'vitest';
import { sourceChatModelAllowed } from '../../../src/shared/source-chat-model-policy.js';
const model = (route: string, overrides = {}) =>
  ({
    modelRoute: { id: route },
    supportedWorkloads: ['chat'],
    capabilities: { toolUse: true, tokenAccounting: true },
    ...overrides,
  }) as never;
it('allows configured compatible providers without model-name or test-environment exceptions', () => {
  expect(sourceChatModelAllowed(model('openai'))).toBe(true);
  expect(sourceChatModelAllowed(model('anthropic'))).toBe(true);
});
it('rejects unknown routes and missing required workload or capabilities', () => {
  expect(sourceChatModelAllowed(model('unknown'))).toBe(false);
  expect(
    sourceChatModelAllowed(model('openai', { supportedWorkloads: [] })),
  ).toBe(false);
  expect(
    sourceChatModelAllowed(
      model('openai', {
        capabilities: { toolUse: false, tokenAccounting: true },
      }),
    ),
  ).toBe(false);
  expect(
    sourceChatModelAllowed(
      model('openai', {
        capabilities: { toolUse: true, tokenAccounting: false },
      }),
    ),
  ).toBe(false);
});
