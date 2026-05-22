import type { LlmProfile } from '../../domain/agent/agent.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCapabilityDescriptor,
  type ModelCatalogEntry,
  type ModelExecutionProviderId,
  type ModelResponseFamily,
  type ModelRouteId,
  type ModelWorkload,
} from '../../shared/model-catalog.js';

export interface ResolvedLlmProfile {
  profile: LlmProfile;
  alias: string;
  modelEntry: ModelCatalogEntry;
  runnerModel: string;
  responseFamily: ModelResponseFamily;
  modelRoute: {
    id: ModelRouteId;
    label: string;
    metadata: {
      providerModelId: string;
    };
  };
  executionProviderId: ModelExecutionProviderId;
  credentialProfileRef: string;
  capabilities: ModelCapabilityDescriptor;
}

export type LlmProfileResolution =
  | { ok: true; value: ResolvedLlmProfile }
  | {
      ok: false;
      reason: 'empty' | 'unknown' | 'raw-provider-id' | 'unsupported-workload';
      message: string;
    };

export class LlmProfileResolutionService {
  resolve(input: {
    profile: LlmProfile;
    workload: ModelWorkload;
  }): LlmProfileResolution {
    const resolved = resolveModelSelectionForWorkload(
      input.profile.modelAlias,
      input.workload,
    );
    if (!resolved.ok) {
      return {
        ok: false,
        reason:
          resolved.reason === 'duplicate-alias' ? 'unknown' : resolved.reason,
        message: resolved.message,
      };
    }
    const credentialProfileRef =
      input.profile.credentialProfileRef ?? resolved.entry.credentialProfileRef;
    return {
      ok: true,
      value: {
        profile: input.profile,
        alias: resolved.alias,
        modelEntry: resolved.entry,
        runnerModel: resolved.runnerModel,
        responseFamily: resolved.entry.responseFamily,
        modelRoute: {
          id: resolved.entry.modelRoute.id,
          label: resolved.entry.modelRoute.label,
          metadata: {
            providerModelId: resolved.entry.modelRoute.providerModelId,
          },
        },
        executionProviderId: resolved.entry.executionProviderId,
        credentialProfileRef,
        capabilities: resolved.entry.capabilities,
      },
    };
  }
}
