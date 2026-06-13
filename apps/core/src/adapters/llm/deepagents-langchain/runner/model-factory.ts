import { initChatModel } from 'langchain/chat_models/universal';
import { ChatOpenRouter } from '@langchain/openrouter';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

// Builds the LangChain chat-model instance the DeepAgents graph runs on. Model
// construction is PROVIDER-DRIVEN, not env-sniffing: the host projects the
// resolved model's provider string (GANTRY_DEEPAGENTS_MODEL_PROVIDER) plus the
// model id, and the single loopback gateway base-URL + run-scoped `gtw_` token
// reach the runner through the gateway-projected OPENAI_BASE_URL/OPENAI_API_KEY
// modelCredentialEnv. There is now ONE gateway base-url+token per run; the
// provider string selects the LangChain class, not which env var is set.
//
// - `openai` (and any other initChatModel provider): `initChatModel` resolves
//   the provider class and forwards `apiKey` + `configuration.baseURL` to the
//   constructor.
// - `openrouter`: first-party `@langchain/openrouter` `ChatOpenRouter` (talks
//   OpenRouter REST/chat-completions via fetch). `initChatModel` does NOT know
//   `openrouter`, so it is constructed directly. Its `buildUrl()` appends
//   `/chat/completions` to `baseURL`, so we pass the gateway base-url + `/v1`
//   (-> loopback `/openrouter/v1/chat/completions` -> openrouter.ai/api/v1/...).
// - `anthropic` is NOT a deepagents provider (Claude is SDK-only); it throws.

export type ModelEndpointFamily = 'openai' | 'openrouter';

const INIT_CHAT_MODEL_PROVIDERS = new Set<string>(['openai']);

export interface ResolvedRunnerModel {
  model: BaseChatModel;
  endpointFamily: ModelEndpointFamily;
  modelId: string;
}

export async function buildRunnerModel(input: {
  provider: string;
  modelId: string;
  gatewayBaseUrl: string;
  gatewayToken: string;
}): Promise<ResolvedRunnerModel> {
  const provider = input.provider.trim().toLowerCase();
  const baseURL = input.gatewayBaseUrl;
  assertLoopbackGatewayUrl(baseURL, 'gateway base URL');
  const apiKey = requireGatewayToken(input.gatewayToken, 'gateway token');

  if (provider === 'openrouter') {
    const model = new ChatOpenRouter({
      model: input.modelId,
      apiKey,
      // ChatOpenRouter.buildUrl() appends `/chat/completions` to baseURL; the
      // loopback gateway expects the `/v1` path segment so it proxies to
      // openrouter.ai/api/v1/chat/completions.
      baseURL: `${trimTrailingSlash(baseURL)}/v1`,
      streamUsage: true,
    });
    return { model, endpointFamily: 'openrouter', modelId: input.modelId };
  }

  if (INIT_CHAT_MODEL_PROVIDERS.has(provider)) {
    const model = await initChatModel(`${provider}:${input.modelId}`, {
      apiKey,
      configuration: { baseURL },
      streamUsage: true,
    });
    return {
      model: model as unknown as BaseChatModel,
      endpointFamily: 'openai',
      modelId: input.modelId,
    };
  }

  throw new Error(
    `DeepAgents runner does not support model provider "${input.provider}". ` +
      'Claude runs on the Anthropic SDK lane; only OpenAI-compatible providers ' +
      'run on the DeepAgents lane.',
  );
}

function requireGatewayToken(value: string | undefined, label: string): string {
  const token = value?.trim();
  if (!token) {
    throw new Error(`DeepAgents runner is missing the ${label}.`);
  }
  if (!token.startsWith('gtw_')) {
    throw new Error(`DeepAgents runner requires a run-scoped Gantry ${label}.`);
  }
  return token;
}

function assertLoopbackGatewayUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`DeepAgents runner ${label} is not a valid URL.`);
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
      `DeepAgents runner ${label} must be a loopback Gantry gateway URL.`,
    );
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
