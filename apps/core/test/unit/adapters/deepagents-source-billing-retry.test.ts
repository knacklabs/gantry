import { createServer } from 'node:http';
import { describe, it, expect } from 'vitest';
import { buildRunnerModel } from '@core/adapters/llm/deepagents-langchain/runner/model-factory.js';
async function fakeProvider(code: string, recover = false) {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    if (recover && requests > 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp_fixture',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-6-luna',
          output: [
            {
              id: 'msg_fixture',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'Recovered fixture',
                  annotations: [],
                },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        }),
      );
      return;
    }
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          type: 'billing_error',
          code,
          message: 'Fixture credits unavailable',
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('Fixture absent');
  return {
    url: `http://127.0.0.1:${address.port}/openai`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
describe('native source provider billing exit', () => {
  it('fails after one real HTTP response for nonrecoverable billing429 instead of waiting for execution timeout', async () => {
    const fixture = await fakeProvider('credit_balance_exhausted');
    try {
      const resolved = await buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-6-luna',
        gatewayBaseUrl: fixture.url,
        gatewayToken: 'gtw_fixture',
        sourceAnswer: true,
        configuredThinking: { mode: 'off' },
        maxOutputTokens: 2000,
      });
      await expect(
        resolved.model.invoke('Fixture only', {
          signal: AbortSignal.timeout(1000),
        }),
      ).rejects.toThrow(
        'Source provider billing unavailable: openai/credit_balance_exhausted',
      );
      expect(fixture.requests()).toBe(1);
    } finally {
      await fixture.close();
    }
  });
  it('does not restart a failed billing request in the real DeepAgents graph', async () => {
    const fixture = await fakeProvider('credit_balance_exhausted');
    try {
      const { createDeepAgent } = await import('deepagents');
      const resolved = await buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-6-luna',
        gatewayBaseUrl: fixture.url,
        gatewayToken: 'gtw_fixture',
        sourceAnswer: true,
        configuredThinking: { mode: 'off' },
        maxOutputTokens: 2000,
      });
      const agent = createDeepAgent({ model: resolved.model, tools: [] });
      await expect(
        agent.invoke(
          { messages: [{ role: 'user', content: 'Fixture only' }] },
          { signal: AbortSignal.timeout(1500) },
        ),
      ).rejects.toThrow(
        'Source provider billing unavailable: openai/credit_balance_exhausted',
      );
      expect(fixture.requests()).toBe(1);
    } finally {
      await fixture.close();
    }
  });
  it('preserves the installed transient rate429 retry policy for source answers', async () => {
    const fixture = await fakeProvider('rate_limit_exceeded', true);
    try {
      const resolved = await buildRunnerModel({
        provider: 'openai',
        modelId: 'gpt-6-luna',
        gatewayBaseUrl: fixture.url,
        gatewayToken: 'gtw_fixture',
        sourceAnswer: true,
        configuredThinking: { mode: 'off' },
        maxOutputTokens: 2000,
      });
      const result = await resolved.model.invoke('Fixture only', {
        signal: AbortSignal.timeout(8000),
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: 'Recovered fixture' }),
        ]),
      );
      expect(fixture.requests()).toBe(2);
    } finally {
      await fixture.close();
    }
  }, 10000);
});
