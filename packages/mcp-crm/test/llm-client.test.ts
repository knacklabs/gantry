import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoondiCrmEnv } from '../src/env.js';

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { createAnthropicExtractorLlm } from '../src/extractor/llm-client.js';

const env: BoondiCrmEnv = {
  port: 8082,
  databaseUrl: 'postgres://test:test@127.0.0.1:5432/test',
  dbSchema: 'boondi_crm',
  gantrySchema: 'gantry',
  identity: { mode: 'disabled' },
  requireVerifiedIdentity: false,
  identityMaxAgeSec: 120,
  logLevel: 'fatal',
  logFormat: 'json',
  crmLeadQueryExtractionWatcher: {
    enabled: false,
    pollIntervalMs: 30000,
    model: 'haiku',
  },
  reconcileAgentId: 'agent:boondi_support',
  modelAppId: 'default',
  anthropicApiKey: 'test-key',
};

async function* assistantText(text: string): AsyncIterable<unknown> {
  yield {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  };
}

describe('createAnthropicExtractorLlm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the configured model even when the background CRM watcher is disabled', async () => {
    mockQuery.mockReturnValueOnce(assistantText('{"opportunities":[]}'));

    const llm = createAnthropicExtractorLlm(env);
    await expect(
      llm?.complete({
        system: 'Extract CRM records.',
        messages: [{ role: 'user', content: 'conversation' }],
      }),
    ).resolves.toBe('{"opportunities":[]}');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ model: 'haiku' }),
      }),
    );
  });
});
