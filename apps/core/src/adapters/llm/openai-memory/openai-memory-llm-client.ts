import { randomUUID } from 'node:crypto';

import type {
  MemoryLlmClient,
  MemoryLlmQueryOpts,
  MemoryLlmUsage,
} from '../../../domain/ports/memory-llm-client.js';
import type { AgentRunId } from '../../../domain/events/events.js';
import { runWithMemoryOperationTimeout } from '../../../shared/memory-dreaming-timeout.js';
import {
  findModelByRunnerModel,
  type ModelRouteId,
} from '../../../shared/model-catalog.js';
import {
  getModelProviderDefinition,
  type ModelProviderDefinition,
} from '../../../shared/model-provider-registry.js';
import { DEEPAGENTS_ENGINE } from '../../../shared/agent-engine.js';
import {
  hasGatewayMemoryAccess,
  resolveGatewayMemoryInjection,
} from './memory-gateway-injection.js';

/**
 * Route-aware memory LLM client for the OpenAI response family. It speaks the
 * Chat Completions API over plain fetch (no LangChain/DeepAgents dependency)
 * through the Gantry loopback model gateway, using the same broker authority
 * lane as Anthropic memory queries. cacheStatic is a no-op for OpenAI: prompt
 * caching is automatic on prefix, so there is no per-block cache control.
 */
export function createOpenAiMemoryLlmClient(): MemoryLlmClient {
  return {
    isConfigured: hasGatewayMemoryAccess,
    query: runOpenAiMemoryQuery,
  };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null };
  }>;
  // Usage is read by field path declared on the provider (see reportUsage):
  // the cache-read field varies (nested prompt_tokens_details.cached_tokens, or
  // flat prompt_cache_hit_tokens / cached_tokens), so usage is treated as an
  // open record and the read field is looked up dynamically.
  usage?: Record<string, unknown>;
}

async function runOpenAiMemoryQuery(opts: MemoryLlmQueryOpts): Promise<string> {
  if (!hasGatewayMemoryAccess()) {
    throw new Error(
      'OpenAI memory access is not configured (configure brokered model access)',
    );
  }
  return runWithMemoryOperationTimeout(
    (signal) => runWithGantryGateway({ ...opts, signal }),
    {
      timeoutMs: opts.timeoutMs,
      parentSignal: opts.signal,
      label: 'memory LLM query',
    },
  );
}

async function runWithGantryGateway(opts: MemoryLlmQueryOpts): Promise<string> {
  opts.signal?.throwIfAborted();
  const modelEntry = opts.modelProfile
    ? findModelByRunnerModel(opts.modelProfile.runnerModel)
    : findModelByRunnerModel(opts.model);
  const routeId: ModelRouteId =
    (opts.modelProfile?.modelRoute as ModelRouteId | undefined) ??
    modelEntry?.modelRoute.id ??
    'openai';
  const provider = requireOpenAiCompatibleProvider(routeId);
  const runId = `memory-query:${randomUUID()}` as AgentRunId;
  const gateway = await resolveGatewayMemoryInjection({
    appId: opts.appId,
    modelRouteId: routeId,
    runId,
  });
  try {
    opts.signal?.throwIfAborted();
    const { baseUrl, token } = readGatewayProjection(
      provider,
      gateway.injection.env,
    );
    const body = JSON.stringify({
      model: opts.model,
      messages: buildMessages(opts),
    });
    const response = await fetch(`${baseUrl}${chatCompletionsTail(provider)}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body,
      signal: opts.signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(
        `OpenAI memory query failed: ${response.status} ${response.statusText}${
          detail ? ` - ${detail}` : ''
        }`,
      );
    }
    const parsed = (await response.json()) as ChatCompletionResponse;
    opts.signal?.throwIfAborted();
    reportUsage(
      opts.onUsage,
      parsed.usage,
      provider.cacheSupport.prompt.usageFields.readTokens,
    );
    return readCompletionText(parsed).trim();
  } finally {
    await gateway.revoke();
  }
}

function buildMessages(
  opts: MemoryLlmQueryOpts,
): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (opts.systemPrompt) {
    messages.push({ role: 'system', content: opts.systemPrompt });
  }
  if (opts.userBlocks?.length) {
    // cacheStatic is intentionally ignored: OpenAI prompt caching is automatic
    // on the request prefix and exposes no per-block cache control.
    for (const block of opts.userBlocks) {
      messages.push({ role: 'user', content: block.text });
    }
  } else {
    messages.push({ role: 'user', content: opts.prompt });
  }
  return messages;
}

function readCompletionText(response: ChatCompletionResponse): string {
  let out = '';
  for (const choice of response.choices ?? []) {
    const content = choice.message?.content;
    if (typeof content === 'string') out += content;
  }
  return out;
}

function reportUsage(
  onUsage: MemoryLlmQueryOpts['onUsage'],
  usage: ChatCompletionResponse['usage'],
  cacheReadField: string | undefined,
): void {
  if (!onUsage || !usage) return;
  const promptTokens = readNumberField(usage, 'prompt_tokens') ?? 0;
  // The cache-read field path is declared per provider on the registry. It is
  // either a flat key (e.g. cached_tokens, prompt_cache_hit_tokens) or a dotted
  // nested path (e.g. prompt_tokens_details.cached_tokens). No declared field
  // means the provider has no prompt cache; treat cached as 0.
  const cachedTokens = cacheReadField
    ? (readNumberField(usage, cacheReadField) ?? 0)
    : 0;
  // The cached count is a SUBSET of prompt_tokens, but the canonical
  // MemoryLlmUsage treats input_tokens and cache_read_input_tokens as disjoint
  // (cf. anthropic memory-query.ts). Subtract the cached portion so the two do
  // not double-count; floor at 0 in case of inconsistent upstream counts.
  const normalized: MemoryLlmUsage = {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: readNumberField(usage, 'completion_tokens') ?? 0,
    ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
  };
  onUsage(normalized);
}

// Reads a numeric usage field by a flat key or a dotted nested path. Returns
// undefined when the path is absent or the leaf is not a number, so callers can
// fall back to 0 without distinguishing missing from zero.
function readNumberField(
  usage: Record<string, unknown>,
  path: string,
): number | undefined {
  let cursor: unknown = usage;
  for (const segment of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'number' ? cursor : undefined;
}

// Accepts any provider that speaks the OpenAI chat/completions API: the native
// OpenAI family, plus OpenAI-compatible DeepAgents-lane providers such as
// OpenRouter (nominal family 'anthropic', OpenAI-shaped transport). The shared
// trait is the deepagents execution engine or the openai response family; both
// project the OpenAI-family gateway env this client reads.
function requireOpenAiCompatibleProvider(
  routeId: ModelRouteId,
): ModelProviderDefinition {
  const provider = getModelProviderDefinition(routeId);
  const compatible =
    provider &&
    (provider.responseFamily === 'openai' ||
      provider.executionRoute.engine === DEEPAGENTS_ENGINE);
  if (!provider || !compatible) {
    throw new Error(
      `Memory model route ${routeId} is not an OpenAI-compatible model route.`,
    );
  }
  return provider;
}

// The chat/completions path tail to POST after the loopback gateway base
// (`http://127.0.0.1:<port>/<segment>`), matching exactly what the runner lane
// posts and what the gateway allowlists per provider. The gateway builds the
// upstream as `upstreamOrigin + upstreamPathPrefix + tail`, then strips the
// per-provider prefix before checking the allowlist (assertProviderPathAllowed):
//   - openai/openrouter need the `/v1` tail because their prefixes do not
//     include that version segment.
//   - every other OpenAI-compatible provider encodes its real version in
//     upstreamPathPrefix (groq `/openai/v1`, gemini `/v1beta/openai`, etc.) and
//     allowlists the bare `/chat/completions`, so the tail must be bare -> e.g.
//     upstream api.groq.com/openai/v1/chat/completions (no double `/v1`).
function chatCompletionsTail(provider: ModelProviderDefinition): string {
  return provider.id === 'openai' || provider.id === 'openrouter'
    ? '/v1/chat/completions'
    : '/chat/completions';
}

function readGatewayProjection(
  provider: ModelProviderDefinition,
  env: Record<string, string>,
): { baseUrl: string; token: string } {
  const projection = provider.gateway.sdkProjection;
  const baseUrl = env[projection.baseUrlEnv];
  const token = env[projection.tokenEnv];
  if (!baseUrl || !token) {
    throw new Error(
      `Setup required: configure ${provider.label} Model Access before running memory on ${provider.id} models.`,
    );
  }
  if (!token.startsWith('gtw_')) {
    throw new Error(
      `Gantry Model Gateway projection for ${provider.label} memory must use a run-scoped gateway token.`,
    );
  }
  return { baseUrl, token };
}
