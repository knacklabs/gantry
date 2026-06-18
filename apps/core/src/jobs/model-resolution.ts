import type { AgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter.js';
import type { AgentExecutionAdapterRegistry } from '../application/agent-execution/agent-execution-adapter-registry.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { resolveConfiguredRuntimeExecutionProviderId } from '../runtime/execution-provider-id.js';
import type { NormalizedModelUsage } from '../shared/model-catalog.js';
import { resolveExecutionRoute } from '../shared/model-execution-route.js';
import { getModelProviderDefinition } from '../shared/model-provider-registry.js';
import {
  modelUseKindForJobSchedule,
  resolveDefaultJobExecutionProviderId,
  resolveJobModel,
  type ResolvedJobModel,
} from '../application/jobs/job-model-resolution.js';

export type { NormalizedModelUsage };
export {
  modelUseKindForJobSchedule,
  resolveDefaultJobExecutionProviderId,
  resolveJobModel,
};

export function resolveJobExecutionProviderId(input: {
  resolvedModel: ResolvedJobModel;
  executionAdapter?: Pick<AgentExecutionAdapter, 'id'>;
  executionAdapters?: Pick<AgentExecutionAdapterRegistry, 'list'>;
  fallbackForInjectedRunner?: boolean;
}): ExecutionProviderId {
  const resolution = input.resolvedModel.resolution;
  let routed: ExecutionProviderId | undefined;
  if (resolution?.ok) {
    const route =
      input.resolvedModel.routeResolution ??
      resolveExecutionRoute({
        entry: resolution.entry,
        agentHarness: input.resolvedModel.agentHarness,
      });
    if (route.ok) {
      routed = route.value.executionProviderId as ExecutionProviderId;
    }
  }
  return (
    routed ??
    resolveConfiguredRuntimeExecutionProviderId({
      executionAdapter: input.executionAdapter,
      executionAdapters: input.executionAdapters,
      fallbackExecutionProviderId: input.fallbackForInjectedRunner
        ? input.resolvedModel.defaultExecutionProviderId
        : undefined,
    })
  );
}

function modelAuditPayload(resolved: ResolvedJobModel) {
  return {
    resolved_model_alias: resolved.resolution?.ok
      ? resolved.resolution.alias
      : null,
    resolved_model_profile_id: resolved.entry?.id ?? null,
    model_source: resolved.source,
    cache_policy: resolved.entry?.cacheMode ?? 'unknown',
  };
}

// Resolved-run diagnostics for the scheduled lane: the inherited agent engine,
// the endpoint family (responseFamily), and the diagnostic executionProviderId.
// No secrets; credential mode and sandbox provider are added at the call site
// where the bound credential and runner sandbox are known.
function resolvedRunDiagnostics(resolved: ResolvedJobModel) {
  const provider = resolved.entry
    ? getModelProviderDefinition(resolved.entry.modelRoute.id)
    : undefined;
  let executionProviderId: string | null = null;
  let supportedCredentialModes: readonly string[] = [];
  if (resolved.resolution?.ok) {
    const route =
      resolved.routeResolution ??
      resolveExecutionRoute({
        entry: resolved.resolution.entry,
        agentHarness: resolved.agentHarness,
      });
    if (route.ok) {
      executionProviderId = route.value.executionProviderId;
      supportedCredentialModes = route.value.supportedCredentialModes;
    }
  }
  return {
    agent_engine: resolved.agentEngine,
    agent_harness: resolved.agentHarness,
    response_family: provider?.responseFamily ?? null,
    execution_provider_id: executionProviderId,
    // Non-secret credential-mode metadata: which credential modes this resolved
    // route accepts. The exact bound mode is enforced later at spawn.
    supported_credential_modes: [...supportedCredentialModes],
  };
}

export function jobStartedModelPayload(resolved: ResolvedJobModel) {
  return {
    ...modelAuditPayload(resolved),
    ...resolvedRunDiagnostics(resolved),
    context_window_tokens: resolved.entry?.contextWindowTokens ?? null,
  };
}

export function jobCompletedModelPayload(
  resolved: ResolvedJobModel,
  usage?: NormalizedModelUsage,
) {
  return {
    usage,
    ...modelAuditPayload(resolved),
  };
}
