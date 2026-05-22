import { describe, expect, it } from 'vitest';

import { llmProfilesPostgres } from '@core/adapters/storage/postgres/schema/agents.js';

describe('llmProfilesPostgres schema', () => {
  it('persists response family as the canonical LLM profile projection column', () => {
    expect(llmProfilesPostgres.responseFamily.name).toBe('response_family');
    expect(llmProfilesPostgres.responseFamily.default).toBe('anthropic');
    expect('provider' in llmProfilesPostgres).toBe(false);
  });
});
