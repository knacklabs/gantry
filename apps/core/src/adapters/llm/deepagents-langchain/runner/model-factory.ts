import { initChatModel } from 'langchain/chat_models/universal';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatOpenRouterInput } from '@langchain/openrouter';
import { GantryChatOpenRouter } from './gantry-chat-openrouter.js';

// Builds the LangChain chat-model instance the DeepAgents graph runs on. Model
// construction is PROVIDER-DRIVEN, not env-sniffing: the host projects the
// resolved model's provider string (GANTRY_DEEPAGENTS_MODEL_PROVIDER) plus the
// model id, and the single loopback gateway base-URL + run-scoped `gtw_` token
// reach the runner through the gateway-projected OPENAI_BASE_URL/OPENAI_API_KEY
// modelCredentialEnv. There is now ONE gateway base-url+token per run; the
// provider string selects the LangChain class, not which env var is set.
//
// - openai-compatible providers (`openai` + groq/deepseek/xai/together/
//   fireworks/cerebras/perplexity/gemini/bedrock/vertex): built with `initChatModel("openai:
//   <id>", ...)` regardless of the real upstream provider, because we hit OUR
//   loopback gateway (not api.openai.com); the gateway routes by pathSegment to
//   the real upstream. `initChatModel` resolves ChatOpenAI and forwards `apiKey`
//   + `configuration.baseURL` to it. The OpenAI SDK posts `<baseURL>/chat/
//   completions` (baseURL is the raw loopback gateway base, no `/v1`), and the
//   gateway prepends each provider's real upstreamPathPrefix.
// - `openrouter`: first-party `@langchain/openrouter` `ChatOpenRouter` (talks
//   OpenRouter REST/chat-completions via fetch). `initChatModel` does NOT know
//   `openrouter`, so it is constructed directly. Its `buildUrl()` appends
//   `/chat/completions` to `baseURL`, so we pass the gateway base-url + `/v1`
//   (-> loopback `/openrouter/v1/chat/completions` -> openrouter.ai/api/v1/...).
// - `anthropic` is NOT a deepagents provider (Claude is SDK-only); it throws.

export type ModelEndpointFamily = 'openai' | 'openrouter';
export type OpenRouterProviderPreferences = NonNullable<
  ChatOpenRouterInput['provider']
>;

// The "openai:" class prefix is correct for ALL of these — they reach the Gantry
// loopback gateway, which routes to the real upstream by pathSegment. Adding a
// provider here is all that is required for the runner to accept it.
const INIT_CHAT_MODEL_PROVIDERS = new Set<string>([
  'openai',
  'groq',
  'deepseek',
  'xai',
  'together',
  'fireworks',
  'cerebras',
  'perplexity',
  'gemini',
  'bedrock',
  'vertex',
]);

// In sandbox_runtime, the host rewrites loopback model gateway URLs to this
// private alias and installs a Gantry-owned egress mapping back to loopback.
// Keep the runner allowlist exact so raw private/provider URLs remain rejected.
const SANDBOX_RUNTIME_MODEL_GATEWAY_HOST = 'model-gateway.gantry.internal';

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
  // Durable session id for OpenRouter sticky cache routing (see below). OpenAI
  // has no session_id concept, so this is applied to the openrouter lane only.
  sessionId?: string;
  promptCacheKey?: string;
  // Curated context window (host-projected GANTRY_DEEPAGENTS_MAX_INPUT_TOKENS)
  // for ids the LangChain library has no built-in profile for. When present it
  // becomes the model profile's `maxInputTokens` so DeepAgents summarizes at 85%
  // of the real window and context-usage reports correctly. When ABSENT (e.g.
  // gpt-5.5/gpt-5.4), the library's real profile is used unchanged.
  maxInputTokens?: number;
  openRouterProviderRouting?: OpenRouterProviderPreferences;
}): Promise<ResolvedRunnerModel> {
  const provider = input.provider.trim().toLowerCase();
  const baseURL = input.gatewayBaseUrl;
  assertLoopbackGatewayUrl(baseURL, 'gateway base URL');
  const apiKey = requireGatewayToken(input.gatewayToken, 'gateway token');
  const maxInputTokens = resolveMaxInputTokens(input.maxInputTokens);

  if (provider === 'openrouter') {
    const sessionId = input.sessionId?.trim();
    // GantryChatOpenRouter overrides `get profile()` to prefer the curated
    // profile; without an override it falls through to the library profile, so
    // we only attach `profileOverride` when the host projected a window.
    const model = new GantryChatOpenRouter({
      model: input.modelId,
      apiKey,
      // ChatOpenRouter.buildUrl() appends `/chat/completions` to baseURL; the
      // loopback gateway expects the `/v1` path segment so it proxies to
      // openrouter.ai/api/v1/chat/completions.
      baseURL: `${trimTrailingSlash(baseURL)}/v1`,
      streamUsage: true,
      ...(maxInputTokens !== undefined
        ? { profileOverride: { maxInputTokens } }
        : {}),
      // Sticky routing: a stable session_id (request body) makes OpenRouter
      // route follow-up turns of the same conversation to the same upstream
      // provider so prompt-cache hits persist across turns. Derived from the
      // durable session id; stable across turns. ChatOpenRouter injects this as
      // body `session_id` via invocationParams.
      ...(sessionId ? { sessionId } : {}),
      ...(input.openRouterProviderRouting
        ? { provider: input.openRouterProviderRouting }
        : {}),
    });
    return { model, endpointFamily: 'openrouter', modelId: input.modelId };
  }

  if (INIT_CHAT_MODEL_PROVIDERS.has(provider)) {
    // The class prefix is ALWAYS "openai:" — we hit the Gantry loopback gateway,
    // which routes to the real upstream (groq/deepseek/xai/...) by pathSegment.
    // initChatModel only knows the LangChain class, and ChatOpenAI is the right
    // class for every OpenAI-chat-completions-compatible upstream.
    const model = await initChatModel(`openai:${input.modelId}`, {
      apiKey,
      configuration: { baseURL },
      ...(input.promptCacheKey
        ? { modelKwargs: { prompt_cache_key: input.promptCacheKey } }
        : {}),
      streamUsage: true,
      // initChatModel stores `profile` on the ConfigurableModel wrapper and its
      // `.profile` getter returns it first, so the curated window reaches both
      // DeepAgents summarization and the stream-normalizer. Omit it when no
      // window was projected (gpt-5.5/gpt-5.4) so the library profile is used.
      ...(maxInputTokens !== undefined ? { profile: { maxInputTokens } } : {}),
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

// Normalizes the optional curated window to a positive finite number or
// undefined (so the profile override is attached only when meaningful).
function resolveMaxInputTokens(value: number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return undefined;
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
  } catch (error) {
    throw new Error(`DeepAgents runner ${label} is not a valid URL.`, {
      cause: error,
    });
  }
  const hostname = url.hostname.toLowerCase();
  const loopback =
    url.protocol === 'http:' &&
    (hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]');
  const sandboxGatewayAlias =
    url.protocol === 'http:' && hostname === SANDBOX_RUNTIME_MODEL_GATEWAY_HOST;
  if (!loopback && !sandboxGatewayAlias) {
    throw new Error(
      `DeepAgents runner ${label} must be a loopback or sandbox-private Gantry gateway URL.`,
    );
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
