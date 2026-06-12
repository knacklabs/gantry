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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
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
  const provider = requireOpenAiFamilyProvider(routeId);
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
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
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
    reportUsage(opts.onUsage, parsed.usage);
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
): void {
  if (!onUsage || !usage) return;
  const promptTokens = usage.prompt_tokens ?? 0;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  // OpenAI cached_tokens is a SUBSET of prompt_tokens, but the canonical
  // MemoryLlmUsage treats input_tokens and cache_read_input_tokens as disjoint
  // (cf. anthropic memory-query.ts). Subtract the cached portion so the two do
  // not double-count; floor at 0 in case of inconsistent upstream counts.
  const normalized: MemoryLlmUsage = {
    input_tokens: Math.max(0, promptTokens - cachedTokens),
    output_tokens: usage.completion_tokens ?? 0,
    ...(cachedTokens ? { cache_read_input_tokens: cachedTokens } : {}),
  };
  onUsage(normalized);
}

function requireOpenAiFamilyProvider(
  routeId: ModelRouteId,
): ModelProviderDefinition {
  const provider = getModelProviderDefinition(routeId);
  if (!provider || provider.responseFamily !== 'openai') {
    throw new Error(
      `Memory model route ${routeId} is not an OpenAI-family model route.`,
    );
  }
  return provider;
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
