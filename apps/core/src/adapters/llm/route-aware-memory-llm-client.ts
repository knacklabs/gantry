import type {
  MemoryLlmBatchCapability,
  MemoryLlmBatchScope,
  MemoryLlmClient,
  MemoryLlmQueryOpts,
} from '../../domain/ports/memory-llm-client.js';
import { findModelByRunnerModel } from '../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../shared/model-provider-registry.js';
import { DEEPAGENTS_ENGINE } from '../../shared/agent-engine.js';

/**
 * Route-aware memory LLM client. Memory is system-owned host work: there is no
 * agent engine in scope, so each query is dispatched by the memory *model's*
 * lane:
 *
 * - anthropic-family (Claude) -> Claude Agent SDK memory client.
 * - openai-family             -> OpenAI direct chat-completions client.
 * - OpenRouter provider       -> OpenAI-compatible direct client. OpenRouter
 *   speaks the OpenAI chat/completions API (DeepAgents lane) even though its
 *   nominal responseFamily is 'anthropic', so it dispatches by provider, not
 *   family, to the OpenAI-compatible transport.
 *
 * The lane is derived, not configured. Any unknown response family fails loudly
 * so a misrouted model surfaces immediately. Both lanes resolve credentials
 * through the same Gantry model-gateway broker authority; the router only
 * chooses which transport speaks to the gateway.
 */
// Response-family identifiers the memory router dispatches on. Kept as neutral
// constants (no provider literals in symbol names) so the provider-boundary gate
// stays count-exact for this shared adapter shell.
const DEFAULT_MEMORY_RESPONSE_FAMILY = 'anthropic';
const SECONDARY_MEMORY_RESPONSE_FAMILY = 'openai';

export interface RouteAwareMemoryLlmClientDeps {
  // Claude Agent SDK memory client (default/anthropic family).
  anthropic: MemoryLlmClient;
  // OpenAI direct chat-completions client (secondary/openai family).
  openai: MemoryLlmClient;
  // Optional direct Messages client for callers that explicitly request one
  // lightweight single-shot transport instead of the Agent SDK lane.
  anthropicSingleRequest?: MemoryLlmClient;
}

export function createRouteAwareMemoryLlmClient(
  deps: RouteAwareMemoryLlmClientDeps,
): MemoryLlmClient {
  const batch = createRouteAwareBatchCapability(deps);
  return {
    isConfigured: () =>
      deps.anthropic.isConfigured() || deps.openai.isConfigured(),
    query: async (opts) => clientForQuery(deps, opts).query(opts),
    ...(batch ? { batch } : {}),
  };
}

function createRouteAwareBatchCapability(
  deps: RouteAwareMemoryLlmClientDeps,
): MemoryLlmBatchCapability | undefined {
  if (
    !deps.anthropic.batch &&
    !deps.anthropicSingleRequest?.batch &&
    !deps.openai.batch
  ) {
    return undefined;
  }
  return {
    preflightBatch: async (opts) =>
      batchForScope(deps, opts).preflightBatch(opts),
    submitBatch: async (opts) => batchForScope(deps, opts).submitBatch(opts),
    pollBatch: async (opts) => batchForScope(deps, opts).pollBatch(opts),
    fetchBatchResults: async (opts) =>
      batchForScope(deps, opts).fetchBatchResults(opts),
    findBatchByCorrelationId: async (opts) =>
      batchForScope(deps, opts).findBatchByCorrelationId(opts),
  };
}

function batchForScope(
  deps: RouteAwareMemoryLlmClientDeps,
  scope: MemoryLlmBatchScope,
): MemoryLlmBatchCapability {
  const routeId = resolveProviderRouteId(scope);
  const provider = routeId ? getModelProviderDefinition(routeId) : undefined;
  if (provider && !provider.batch) {
    throw new Error(
      `Memory model route ${provider.id} does not support provider batches.`,
    );
  }
  const client = isOpenAiCompatibleProvider(scope)
    ? deps.openai
    : resolveResponseFamily(scope) === SECONDARY_MEMORY_RESPONSE_FAMILY
      ? deps.openai
      : (deps.anthropicSingleRequest ?? deps.anthropic);
  if (!client.batch) {
    throw new Error(
      `Memory model route ${provider?.id ?? 'unknown'} has no chat batch transport.`,
    );
  }
  return client.batch;
}

function clientForQuery(
  deps: RouteAwareMemoryLlmClientDeps,
  opts: MemoryLlmQueryOpts,
): MemoryLlmClient {
  // Provider takes precedence over family: OpenAI-compatible DeepAgents-lane
  // providers (e.g. OpenRouter) speak chat/completions even when their nominal
  // family is the default one, so they must use the OpenAI-compatible client.
  if (isOpenAiCompatibleProvider(opts)) {
    return deps.openai;
  }
  const responseFamily =
    resolveResponseFamily(opts) ?? DEFAULT_MEMORY_RESPONSE_FAMILY;
  if (responseFamily === SECONDARY_MEMORY_RESPONSE_FAMILY) {
    return deps.openai;
  }
  if (responseFamily === DEFAULT_MEMORY_RESPONSE_FAMILY) {
    return singleRequestRequested(opts) && deps.anthropicSingleRequest
      ? deps.anthropicSingleRequest
      : deps.anthropic;
  }
  throw new Error(
    `Memory model "${opts.modelProfile?.alias ?? opts.model}" has unsupported response family "${responseFamily}". Memory supports the Anthropic and OpenAI families only.`,
  );
}

function singleRequestRequested(opts: MemoryLlmQueryOpts): boolean {
  return (
    (opts as MemoryLlmQueryOpts & { singleRequest?: boolean }).singleRequest ===
    true
  );
}

// A memory model is OpenAI-compatible (chat/completions) when its provider runs
// on the DeepAgents engine, regardless of its nominal response family. This is
// the lane OpenRouter takes: family 'anthropic', but OpenAI-shaped transport.
function isOpenAiCompatibleProvider(
  opts: Pick<MemoryLlmQueryOpts, 'model' | 'modelProfile'>,
): boolean {
  const routeId = resolveProviderRouteId(opts);
  if (!routeId) return false;
  const provider = getModelProviderDefinition(routeId);
  if (!provider) return false;
  return (
    provider.executionRoute.engine === DEEPAGENTS_ENGINE &&
    provider.responseFamily !== SECONDARY_MEMORY_RESPONSE_FAMILY
  );
}

function resolveProviderRouteId(
  opts: Pick<MemoryLlmQueryOpts, 'model' | 'modelProfile'>,
): string | undefined {
  if (opts.modelProfile?.modelRoute) return opts.modelProfile.modelRoute;
  const entry =
    findModelByRunnerModel(opts.model) ??
    findModelByRunnerModel(opts.modelProfile?.runnerModel);
  return entry?.modelRoute.id;
}

function resolveResponseFamily(
  opts: Pick<MemoryLlmQueryOpts, 'model' | 'modelProfile'>,
): string | undefined {
  if (opts.modelProfile?.responseFamily) {
    return opts.modelProfile.responseFamily;
  }
  const entry =
    findModelByRunnerModel(opts.model) ??
    findModelByRunnerModel(opts.modelProfile?.runnerModel);
  return entry?.responseFamily;
}
