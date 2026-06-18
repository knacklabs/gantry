import {
  listModelCatalogEntries,
  resolveModelSelectionForWorkload,
} from '../../../shared/model-catalog.js';
import { resolveModelCacheSupport } from '../../../shared/model-cache-support.js';
import {
  executionRoutesForEntry,
  resolveExecutionRoute,
} from '../../../shared/model-execution-route.js';
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
    executionRoutes: executionRoutesForEntry(entry),
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

// `gantry model why <alias> --agent <id>` preview. Resolves the model alias
// against the agent's selected harness, surfacing endpoint family, credential
// profile, and diagnostic executionProviderId.
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
  const agentHarness = ctx.getSelectedAgentHarness(agentFolder);
  const route = resolveExecutionRoute({ entry, agentHarness });
  if (!route.ok) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_REQUEST',
      message: route.message,
    };
  }
  return {
    ok: true,
    body: {
      target: 'agent',
      agentId: agentFolder,
      agentHarness,
      credentialProfile: entry.credentialProfileRef,
      selection: {
        configuredAlias: null,
        effectiveAlias: resolution.alias,
        source: `agent ${agentFolder} harness ${agentHarness}`,
        inherited: false,
        workload: 'chat',
        model: modelRecord(entry),
      },
      executionProviderId: route.value.executionProviderId,
      why: [
        `agent ${agentFolder} uses ${agentHarness} harness on the ${entry.responseFamily} endpoint`,
      ],
    },
  };
}
