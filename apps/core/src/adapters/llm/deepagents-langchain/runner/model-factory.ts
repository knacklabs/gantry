import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// Builds the LangChain chat-model instance the DeepAgents graph runs on. Model
// credentials reach the runner only through Gantry's loopback model gateway env
// (gateway-projected OPENAI_BASE_URL/OPENAI_API_KEY or
// ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY). LOAD-BEARING: ChatAnthropic does NOT
// read ANTHROPIC_BASE_URL from env, so anthropicApiUrl must be passed
// explicitly; ChatOpenAI must receive configuration.baseURL + apiKey explicitly.

export type ModelEndpointFamily = 'openai' | 'anthropic';

export interface ModelFactoryEnv {
  OPENAI_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
}

export interface ResolvedRunnerModel {
  model: BaseChatModel;
  endpointFamily: ModelEndpointFamily;
  modelId: string;
}

export function resolveModelEndpointFamily(
  env: ModelFactoryEnv,
): ModelEndpointFamily {
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) return 'openai';
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_API_KEY) return 'anthropic';
  throw new Error(
    'DeepAgents runner is missing gateway model credentials. Expected loopback ' +
      'OPENAI_BASE_URL/OPENAI_API_KEY or ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY.',
  );
}

export function buildRunnerModel(input: {
  modelId: string;
  env: ModelFactoryEnv;
}): ResolvedRunnerModel {
  const endpointFamily = resolveModelEndpointFamily(input.env);
  if (endpointFamily === 'openai') {
    const baseURL = input.env.OPENAI_BASE_URL!;
    assertLoopbackGatewayUrl(baseURL, 'OPENAI_BASE_URL');
    const apiKey = requireGatewayToken(
      input.env.OPENAI_API_KEY,
      'OPENAI_API_KEY',
    );
    const model = new ChatOpenAI({
      model: input.modelId,
      apiKey,
      configuration: { baseURL },
      streamUsage: true,
    });
    return { model, endpointFamily, modelId: input.modelId };
  }
  const anthropicApiUrl = input.env.ANTHROPIC_BASE_URL!;
  assertLoopbackGatewayUrl(anthropicApiUrl, 'ANTHROPIC_BASE_URL');
  const apiKey = requireGatewayToken(
    input.env.ANTHROPIC_API_KEY,
    'ANTHROPIC_API_KEY',
  );
  const model = new ChatAnthropic({
    model: input.modelId,
    apiKey,
    anthropicApiUrl,
    streamUsage: true,
  });
  return { model, endpointFamily, modelId: input.modelId };
}

function requireGatewayToken(value: string | undefined, key: string): string {
  const token = value?.trim();
  if (!token) {
    throw new Error(`DeepAgents runner is missing gateway token env ${key}.`);
  }
  if (!token.startsWith('gtw_')) {
    throw new Error(
      `DeepAgents runner requires a run-scoped Gantry gateway token in ${key}.`,
    );
  }
  return token;
}

function assertLoopbackGatewayUrl(value: string, key: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`DeepAgents runner ${key} is not a valid URL.`);
  }
  const hostname = url.hostname.toLowerCase();
  const loopback =
    url.protocol === 'http:' &&
    (hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]');
  if (!loopback) {
    throw new Error(
      `DeepAgents runner ${key} must be a loopback Gantry gateway URL.`,
    );
  }
}
