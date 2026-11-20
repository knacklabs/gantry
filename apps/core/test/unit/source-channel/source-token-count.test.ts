import { describe, it, expect, vi, afterEach } from 'vitest';
const gateway = vi.hoisted(() => ({
  revoke: vi.fn(async () => {}),
  injection: {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3939/llm',
      ANTHROPIC_AUTH_TOKEN: 'gtw_test_only',
      ANTHROPIC_API_KEY: 'gtw_test_only',
    },
  },
}));
vi.mock(
  '../../../src/adapters/llm/openai-memory/memory-gateway-injection.js',
  () => ({ resolveGatewayMemoryInjection: vi.fn(async () => gateway) }),
);
import { countAnthropicSourceTokens } from '../../../src/adapters/llm/anthropic-claude-agent/source-token-count.js';
describe('native source token counting boundary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });
  it('uses an app-scoped native count-only request with exact model and revokes its temporary authority', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ input_tokens: 8765 }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await countAnthropicSourceTokens({
        appId: 'test-app' as never,
        model: 'haiku',
        prompt: 'Exact authorized sources',
        timeoutMs: 2000,
      }),
    ).toBe(8765);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:3939/llm/v1/messages/count_tokens',
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toMatch(/^claude-haiku-4-5/);
    expect(body.messages).toEqual([
      { role: 'user', content: 'Exact authorized sources' },
    ]);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('effort');
    expect(gateway.revoke).toHaveBeenCalledTimes(1);
  });
  it('fails closed on invalid counts and revokes authority without returning provider body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ input_tokens: '9000' }),
      })),
    );
    await expect(
      countAnthropicSourceTokens({
        appId: 'test-app' as never,
        model: 'haiku',
        prompt: 'x',
      }),
    ).rejects.toThrow(/response invalid/);
    expect(gateway.revoke).toHaveBeenCalledTimes(1);
  });
});
