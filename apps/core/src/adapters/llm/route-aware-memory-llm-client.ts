import type {
  MemoryLlmClient,
  MemoryLlmQueryOpts,
} from '../../domain/ports/memory-llm-client.js';
import { findModelByRunnerModel } from '../../shared/model-catalog.js';

/**
 * Route-aware memory LLM client. Memory is system-owned host work: there is no
 * agent engine in scope, so each query is dispatched purely by the memory
 * *model's* response family:
 *
 * - anthropic-family -> Claude Agent SDK memory client.
 * - openai-family    -> OpenAI direct chat-completions client.
 *
 * The engine is derived, not configured: the family fully determines the lane.
 * Any unknown response family fails loudly so a misrouted model surfaces
 * immediately. Both lanes resolve credentials through the same Gantry
 * model-gateway broker authority; the router only chooses which transport speaks
 * to the gateway.
 *
 * NOTE (Packet 5): OpenRouter models currently carry responseFamily 'anthropic'
 * and therefore route to the Claude SDK memory client here. Once the OpenRouter
 * gateway projection moves to the OpenAI-compatible lane, OpenRouter memory must
 * route through `openai` instead. Tracked in
 * apps/core/src/shared/model-provider-registry.ts (openrouter responseFamily).
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
}

export function createRouteAwareMemoryLlmClient(
  deps: RouteAwareMemoryLlmClientDeps,
): MemoryLlmClient {
  return {
    isConfigured: () =>
      deps.anthropic.isConfigured() || deps.openai.isConfigured(),
    query: async (opts) => clientForQuery(deps, opts).query(opts),
  };
}

function clientForQuery(
  deps: RouteAwareMemoryLlmClientDeps,
  opts: MemoryLlmQueryOpts,
): MemoryLlmClient {
  const responseFamily =
    resolveResponseFamily(opts) ?? DEFAULT_MEMORY_RESPONSE_FAMILY;
  if (responseFamily === SECONDARY_MEMORY_RESPONSE_FAMILY) {
    return deps.openai;
  }
  if (responseFamily === DEFAULT_MEMORY_RESPONSE_FAMILY) {
    return deps.anthropic;
  }
  throw new Error(
    `Memory model "${opts.modelProfile?.alias ?? opts.model}" has unsupported response family "${responseFamily}". Memory supports the Anthropic and OpenAI families only.`,
  );
}

function resolveResponseFamily(opts: MemoryLlmQueryOpts): string | undefined {
  if (opts.modelProfile?.responseFamily) {
    return opts.modelProfile.responseFamily;
  }
  const entry =
    findModelByRunnerModel(opts.model) ??
    findModelByRunnerModel(opts.modelProfile?.runnerModel);
  return entry?.responseFamily;
}
