import { initChatModel } from 'langchain/chat_models/universal';
import { GantryChatOpenRouter } from './gantry-chat-openrouter.js';
// The "openai:" class prefix is correct for ALL of these — they reach the Gantry
// loopback gateway, which routes to the real upstream by pathSegment. Adding a
// provider here is all that is required for the runner to accept it.
const INIT_CHAT_MODEL_PROVIDERS = new Set([
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
export async function buildRunnerModel(input) {
    const provider = input.provider.trim().toLowerCase();
    const baseURL = input.gatewayBaseUrl;
    assertLoopbackGatewayUrl(baseURL, 'gateway base URL');
    const apiKey = requireGatewayToken(input.gatewayToken, 'gateway token');
    const maxInputTokens = resolveMaxInputTokens(input.maxInputTokens);
    const maxOutputTokens = resolveMaxOutputTokens(input.maxOutputTokens);
    const reasoningEffort = resolveReasoningEffort({
        provider,
        effort: input.effort,
        thinking: input.configuredThinking,
    });
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
            ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
            ...(reasoningEffort
                ? { modelKwargs: { reasoning: { effort: reasoningEffort } } }
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
            ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
            ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
            streamUsage: true,
            // initChatModel stores `profile` on the ConfigurableModel wrapper and its
            // `.profile` getter returns it first, so the curated window reaches both
            // DeepAgents summarization and the stream-normalizer. Omit it when no
            // window was projected (gpt-5.5/gpt-5.4) so the library profile is used.
            ...(maxInputTokens !== undefined ? { profile: { maxInputTokens } } : {}),
        });
        return {
            model: model,
            endpointFamily: 'openai',
            modelId: input.modelId,
        };
    }
    throw new Error(`DeepAgents runner does not support model provider "${input.provider}". ` +
        'Claude runs on the Anthropic SDK lane; only OpenAI-compatible providers ' +
        'run on the DeepAgents lane.');
}
function resolveReasoningEffort(input) {
    if (input.thinking?.budgetTokens !== undefined) {
        throw new Error(`DeepAgents model provider "${input.provider}" does not support thinking budget tokens.`);
    }
    if (input.effort === 'max') {
        throw new Error(`DeepAgents model provider "${input.provider}" does not support effort "max".`);
    }
    const effort = input.thinking?.mode === 'off'
        ? 'none'
        : (input.effort ??
            (input.thinking?.mode === 'on' ? 'medium' : undefined));
    if (effort !== undefined &&
        input.provider !== 'openai' &&
        input.provider !== 'openrouter') {
        throw new Error(`DeepAgents model provider "${input.provider}" does not support reasoning effort.`);
    }
    return effort;
}
// Normalizes the optional curated window to a positive finite number or
// undefined (so the profile override is attached only when meaningful).
function resolveMaxInputTokens(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value;
    }
    return undefined;
}
function resolveMaxOutputTokens(value) {
    if (value === undefined)
        return undefined;
    if (Number.isInteger(value) && value > 0)
        return value;
    throw new Error('DeepAgents max_output_tokens must be a positive integer.');
}
function requireGatewayToken(value, label) {
    const token = value?.trim();
    if (!token) {
        throw new Error(`DeepAgents runner is missing the ${label}.`);
    }
    if (!token.startsWith('gtw_')) {
        throw new Error(`DeepAgents runner requires a run-scoped Gantry ${label}.`);
    }
    return token;
}
function assertLoopbackGatewayUrl(value, label) {
    let url;
    try {
        url = new URL(value);
    }
    catch (error) {
        throw new Error(`DeepAgents runner ${label} is not a valid URL.`, {
            cause: error,
        });
    }
    const hostname = url.hostname.toLowerCase();
    const loopback = url.protocol === 'http:' &&
        (hostname === '127.0.0.1' ||
            hostname === 'localhost' ||
            hostname === '::1' ||
            hostname === '[::1]');
    const sandboxGatewayAlias = url.protocol === 'http:' && hostname === SANDBOX_RUNTIME_MODEL_GATEWAY_HOST;
    if (!loopback && !sandboxGatewayAlias) {
        throw new Error(`DeepAgents runner ${label} must be a loopback or sandbox-private Gantry gateway URL.`);
    }
}
function trimTrailingSlash(value) {
    return value.replace(/\/+$/, '');
}
