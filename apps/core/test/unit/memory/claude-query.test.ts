import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: queryMock,
}));

describe('runClaudeQuery', () => {
  let runtimeRoot = '';

  beforeEach(() => {
    runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'myclaw-claude-query-'),
    );
    vi.stubEnv('AGENT_ROOT', runtimeRoot);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    queryMock.mockReset();
  });

  afterEach(() => {
    if (runtimeRoot) {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
      runtimeRoot = '';
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes resolved OAuth and API key into SDK query env', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-token');
    vi.stubEnv('ANTHROPIC_API_KEY', 'api-key');

    queryMock.mockImplementation(() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '[{"kind":"fact"}]' }],
          },
        };
      })(),
    );

    const { runClaudeQuery } = await import('@core/memory/claude-query.js');
    await runClaudeQuery({
      model: 'claude-haiku-4-5-20251001',
      prompt: 'Extract facts',
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const call = queryMock.mock.calls[0]?.[0] as
      | {
          options?: {
            env?: Record<string, string>;
          };
        }
      | undefined;
    expect(call?.options?.env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
      ANTHROPIC_API_KEY: 'api-key',
    });
  });
});
