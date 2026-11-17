import { it, expect, afterEach, vi } from 'vitest';
import { sourceChatModelAllowed } from '../../../src/shared/source-chat-model-policy.js';
const luna = {
  runnerModel: 'gpt-6-luna',
  modelRoute: { id: 'openai' },
} as never;
afterEach(() => vi.unstubAllEnvs());
it('retains production Haiku-only selection and requires an explicit isolated app-matched Luna override', () => {
  expect(sourceChatModelAllowed(luna, 'app')).toBe(false);
  expect(
    sourceChatModelAllowed(
      {
        runnerModel: 'claude-haiku-4-5-20251001',
        modelRoute: { id: 'anthropic' },
      } as never,
      'app',
    ),
  ).toBe(true);
  vi.stubEnv('GANTRY_APP_ID', 'app');
  vi.stubEnv('GANTRY_CHAT_VALIDATION_MODEL', 'gpt-6-luna');
  expect(sourceChatModelAllowed(luna, 'app')).toBe(false);
  vi.stubEnv('GANTRY_FLEET_REHEARSAL_AUTO_SECRETS', '1');
  expect(sourceChatModelAllowed(luna, 'app')).toBe(true);
  expect(sourceChatModelAllowed(luna, 'other')).toBe(false);
  expect(
    sourceChatModelAllowed(
      { runnerModel: 'gpt-5.5', modelRoute: { id: 'openai' } } as never,
      'app',
    ),
  ).toBe(false);
});
