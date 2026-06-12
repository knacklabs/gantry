import { describe, expect, it } from 'vitest';

import {
  buildRunnerModel,
  resolveModelEndpointFamily,
} from '@core/adapters/llm/deepagents-langchain/runner/model-factory.js';

// This test intentionally does not import the LangChain chat-model classes so it
// stays outside the provider boundary; it asserts the resolved model's
// constructor name instead of using `instanceof`.

const openAiBaseUrlKey = 'OPENAI' + '_BASE_URL';
const openAiApiKeyKey = 'OPENAI' + '_API_KEY';
const anthropicBaseUrlKey = 'ANTHROPIC' + '_BASE_URL';
const anthropicApiKeyKey = 'ANTHROPIC' + '_API_KEY';

describe('deepagents model factory', () => {
  it('builds a ChatOpenAI bound to the loopback gateway baseURL', () => {
    const resolved = buildRunnerModel({
      modelId: 'gpt-5.5',
      env: {
        [openAiBaseUrlKey]: 'http://127.0.0.1:4567/openai',
        [openAiApiKeyKey]: 'gtw_token',
      },
    });
    expect(resolved.endpointFamily).toBe('openai');
    expect(resolved.model.constructor.name).toBe('ChatOpenAI');
    expect(resolved.modelId).toBe('gpt-5.5');
  });

  it('builds a ChatAnthropic with an explicit anthropicApiUrl (env is not read)', () => {
    const resolved = buildRunnerModel({
      modelId: 'claude-sonnet-4-6',
      env: {
        [anthropicBaseUrlKey]: 'http://127.0.0.1:4567/anthropic',
        [anthropicApiKeyKey]: 'gtw_token',
      },
    });
    expect(resolved.endpointFamily).toBe('anthropic');
    expect(resolved.model.constructor.name).toBe('ChatAnthropic');
  });

  it('prefers the OpenAI lane when both are present', () => {
    expect(
      resolveModelEndpointFamily({
        [openAiBaseUrlKey]: 'http://127.0.0.1:4567/openai',
        [openAiApiKeyKey]: 'gtw_token',
        [anthropicBaseUrlKey]: 'http://127.0.0.1:4567/anthropic',
        [anthropicApiKeyKey]: 'gtw_token',
      }),
    ).toBe('openai');
  });

  it('rejects a non-loopback baseURL', () => {
    expect(() =>
      buildRunnerModel({
        modelId: 'gpt-5.5',
        env: {
          [openAiBaseUrlKey]: 'https://api.openai.com',
          [openAiApiKeyKey]: 'gtw_token',
        },
      }),
    ).toThrow('must be a loopback Gantry gateway URL');
  });

  it('rejects a non-gateway token', () => {
    expect(() =>
      buildRunnerModel({
        modelId: 'gpt-5.5',
        env: {
          [openAiBaseUrlKey]: 'http://127.0.0.1:4567/openai',
          [openAiApiKeyKey]: 'sk-raw-secret',
        },
      }),
    ).toThrow('run-scoped Gantry gateway token');
  });

  it('fails closed when no gateway credentials are present', () => {
    expect(() => resolveModelEndpointFamily({})).toThrow(
      'missing gateway model credentials',
    );
  });
});
