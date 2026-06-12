import {
  listModelCatalogEntries,
  resolveModelSelectionForWorkload,
} from '../../../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../../../shared/model-cache-support.js';
import { getModelProviderDefinition } from '../../../shared/model-provider-registry.js';
import { resolveExecutionRoute } from '../../../shared/model-execution-route.js';
import { agentEngineLabel } from '../../../shared/agent-engine.js';
import type { ControlRouteContext } from '../handler-context.js';

export type AgentModelPreviewResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; code: string; message: string };

function modelRecord(
  entry: ReturnType<typeof listModelCatalogEntries>[number],
) {
  return {
    id: entry.id,
    displayName: entry.displayName,
    aliases: entry.aliases,
    recommendedAlias: entry.recommendedAlias,
    responseFamily: entry.responseFamily,
    executionRoutes: (
      getModelProviderDefinition(entry.modelRoute.id)?.executionRoutes ?? []
    ).map((route) => ({
      engine: route.engine,
      executionProviderId: route.executionProviderId,
    })),
    credentialProfileRef: entry.credentialProfileRef,
    modelRoute: {
      id: entry.modelRoute.id,
      label: entry.modelRoute.label,
      metadata: { providerModelId: entry.modelRoute.providerModelId },
    },
    capabilities: entry.capabilities,
    supportedWorkloads: entry.supportedWorkloads,
    contextWindowTokens: entry.contextWindowTokens,
    maxOutputTokens: entry.maxOutputTokens,
    cacheMode: entry.cacheMode,
    cacheTokenFields: entry.cacheTokenFields,
    cacheSupport: resolveModelCacheSupport(entry),
    supportsThinking: entry.supportsThinking,
    supportsTools: entry.supportsTools,
    source: entry.source,
    experimental: entry.experimental === true,
  };
}

// `gantry model why <alias> --agent <id>` preview. Resolves the model alias and
// the agent's effective engine into an execution route, surfacing the endpoint
// family, credential profile, agent engine, and diagnostic executionProviderId.
// An incompatible model/engine pairing returns the locked plan copy in
// `incompatible` (HTTP 200) instead of a stack trace, so the CLI prints guidance
// rather than failing.
export function agentModelPreview(
  ctx: ControlRouteContext,
  body: Record<string, unknown>,
): AgentModelPreviewResult {
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const modelAlias =
    typeof body.modelAlias === 'string' ? body.modelAlias.trim() : '';
  if (!agentId || !modelAlias) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: 'agentId and modelAlias are required for target "agent".',
    };
  }
  const agentFolder = agentId.replace(/^agent:/, '');
  const agentEngine = ctx.getEffectiveAgentEngine(agentFolder);
  const resolution = resolveModelSelectionForWorkload(modelAlias, 'chat');
  if (!resolution.ok) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: resolution.message,
    };
  }
  const entry = resolution.entry;
  const route = resolveExecutionRoute({ entry, agentEngine });
  return {
    ok: true,
    body: {
      target: 'agent',
      agentId: agentFolder,
      agentEngine,
      agentEngineLabel: agentEngineLabel(agentEngine),
      credentialProfile: entry.credentialProfileRef,
      selection: {
        configuredAlias: null,
        effectiveAlias: resolution.alias,
        source: `agent ${agentFolder} engine ${agentEngine}`,
        inherited: false,
        workload: 'chat',
        model: modelRecord(entry),
      },
      ...(route.ok
        ? { executionProviderId: route.value.executionProviderId }
        : { incompatible: route.message }),
      why: route.ok
        ? [
            `agent ${agentFolder} runs ${agentEngineLabel(agentEngine)} on the ${entry.responseFamily} endpoint`,
          ]
        : [route.message],
    },
  };
}
