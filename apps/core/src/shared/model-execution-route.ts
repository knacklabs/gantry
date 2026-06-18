import type { AgentEngine, AgentHarness } from './agent-engine.js';
import {
  AUTO_AGENT_HARNESS,
  DEFAULT_AGENT_ENGINE,
  DEEPAGENTS_ENGINE,
} from './agent-engine.js';
import type {
  ModelCatalogEntry,
  ModelExecutionProviderId,
} from './model-catalog.js';
import {
  getModelProviderDefinition,
  listModelRouteProviders,
  type ModelExecutionRoute,
} from './model-provider-registry.js';

export interface ResolvedExecutionRoute {
  route: ModelExecutionRoute;
  engine: AgentEngine;
  executionProviderId: ModelExecutionRoute['executionProviderId'];
  supportedCredentialModes: readonly string[];
}

export type ExecutionRouteResolution =
  | { ok: true; value: ResolvedExecutionRoute }
  | {
      ok: false;
      reason: 'unknown-provider' | 'incompatible-harness';
      message: string;
    };

// Resolves `modelAlias -> executionRoute`. The engine is no longer chosen: it is
// derived from the resolved entry's provider, which carries the single execution
// route (engine + execution adapter + supported credential modes). Credential-mode
// rejection happens later, where the bound credential mode is known, using
// `supportedCredentialModes`.
export function resolveExecutionRoute(input: {
  entry: ModelCatalogEntry;
  agentHarness?: AgentHarness;
}): ExecutionRouteResolution {
  const { entry } = input;
  const provider = getModelProviderDefinition(entry.modelRoute.id);
  if (!provider) {
    return {
      ok: false,
      reason: 'unknown-provider',
      message: `Model ${entry.recommendedAlias} references unsupported provider route ${entry.modelRoute.id}.`,
    };
  }
  const route = provider.executionRoute;
  const agentHarness = input.agentHarness ?? AUTO_AGENT_HARNESS;
  if (agentHarness !== AUTO_AGENT_HARNESS && agentHarness !== route.engine) {
    return {
      ok: false,
      reason: 'incompatible-harness',
      message: `Model ${entry.recommendedAlias} cannot run with agent harness ${agentHarness}.`,
    };
  }
  return {
    ok: true,
    value: {
      route,
      engine: route.engine,
      executionProviderId: route.executionProviderId,
      supportedCredentialModes: route.supportedCredentialModes,
    },
  };
}

// Read-only diagnostic for model-catalog response shapes: the derived single
// route as a one-element array (engine + executionProviderId). Returns an empty
// array for an unknown provider so the response field stays well-formed.
export function executionRoutesForEntry(
  entry: ModelCatalogEntry,
): { harness: AgentEngine; executionProviderId: ModelExecutionProviderId }[] {
  const provider = getModelProviderDefinition(entry.modelRoute.id);
  if (!provider) return [];
  return [
    {
      harness: provider.executionRoute.engine,
      executionProviderId: provider.executionRoute.executionProviderId,
    },
  ];
}

// Diagnostic label for the memory transport a model resolves to. Mirrors the
// route-aware memory client's dispatch: provider takes precedence over family,
// so a DeepAgents-lane provider (e.g. OpenRouter, nominal family 'anthropic')
// reports 'openai_direct' because it speaks chat/completions. Otherwise the
// default family uses the native SDK client and the secondary family the
// OpenAI-compatible direct client. Returns null for an unknown family.
export type MemoryTransportLane = 'native_sdk' | 'openai_direct';
const DEFAULT_MEMORY_RESPONSE_FAMILY = 'anthropic';
const SECONDARY_MEMORY_RESPONSE_FAMILY = 'openai';
export function memoryTransportLaneForModel(input: {
  providerId?: string | null;
  responseFamily: string | null | undefined;
}): MemoryTransportLane | null {
  if (input.providerId) {
    const provider = getModelProviderDefinition(input.providerId);
    if (
      provider &&
      provider.executionRoute.engine === DEEPAGENTS_ENGINE &&
      provider.responseFamily !== SECONDARY_MEMORY_RESPONSE_FAMILY
    ) {
      return 'openai_direct';
    }
  }
  if (input.responseFamily === SECONDARY_MEMORY_RESPONSE_FAMILY) {
    return 'openai_direct';
  }
  if (input.responseFamily === DEFAULT_MEMORY_RESPONSE_FAMILY) {
    return 'native_sdk';
  }
  return null;
}

// The single provider -> engine derivation point. The engine is read-only:
// callers pass the resolved model's provider id and get the engine its models
// run on. Unknown providers fall back to the system default.
export function deriveAgentEngineForProvider(providerId: string): AgentEngine {
  const provider = getModelProviderDefinition(providerId);
  return provider?.executionRoute.engine ?? DEFAULT_AGENT_ENGINE;
}

// Reverse lookup: which agent engine an internal `executionProviderId` belongs
// to. The execution-route registry maps each provider to its single
// `executionProviderId`; this inverts it so run diagnostics (job run detail,
// run-start audit) can surface the derived engine from the persisted diagnostic
// provider id. Returns undefined for an unknown provider id.
export function engineForExecutionProviderId(
  executionProviderId: string,
): AgentEngine | undefined {
  const normalized = executionProviderId.trim();
  for (const provider of listModelRouteProviders()) {
    if (provider.executionRoute.executionProviderId === normalized) {
      return provider.executionRoute.engine;
    }
  }
  return undefined;
}
