import { randomUUID } from 'node:crypto';

import { getAgentCredentialInjection } from '../../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../credentials/agent-credential-broker-factory.js';
import { getRuntimeStorage } from '../storage/postgres/runtime-store.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import {
  getModelPreset,
  resolveModelSelectionForWorkload,
  type ModelPresetId,
} from '../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../shared/model-provider-registry.js';
import { validateModelCredentialProjectionForEntry } from './anthropic-claude-agent/model-provider-credential-validation.js';

export interface ModelPresetPreflightResult {
  ok: boolean;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
}

export interface ModelPresetPreflightSettings {
  credentialBroker: {
    mode: 'none' | 'gantry';
    gateway?: {
      bindHost: string;
    };
  };
}

export async function preflightModelPreset(input: {
  runtimeHome: string;
  preset: ModelPresetId;
  settings: ModelPresetPreflightSettings;
  appId?: AppId;
}): Promise<ModelPresetPreflightResult> {
  void input.runtimeHome;
  const { preset: presetId, settings } = input;
  const preset = getModelPreset(presetId);
  const model = resolveModelSelectionForWorkload(preset.chatDefault, 'chat');
  if (!model.ok) return { ok: false, status: 'fail', message: model.message };
  if (settings.credentialBroker.mode !== 'gantry') {
    return {
      ok: false,
      status: 'fail',
      message: `${preset.label} requires Gantry Model Gateway credentials.`,
    };
  }
  const runId = `model-preflight:${randomUUID()}` as AgentRunId;
  let broker: AgentCredentialBroker | undefined;
  try {
    broker = await createAgentCredentialBroker({
      mode: settings.credentialBroker.mode,
      modelCredentials: getRuntimeStorage().repositories.modelCredentials,
      gatewayBindHost: settings.credentialBroker.gateway?.bindHost,
    });
    if (!broker) {
      return {
        ok: false,
        status: 'fail',
        message: 'Gantry Model Gateway is not configured.',
      };
    }
    const injection = await getAgentCredentialInjection({
      mode: 'gantry',
      purpose: 'model_runtime',
      appId: input.appId,
      runId,
      modelRouteId: model.entry.modelRoute.id,
      broker,
    });
    validateModelCredentialProjectionForEntry({
      model: model.entry,
      projection: {
        env: injection.env,
        credentialProviders: injection.credentialProviders,
        brokerProfile: injection.brokerProfile,
      },
    });
    return {
      ok: true,
      status: 'pass',
      message: `${getModelProviderDefinition(model.entry.modelRoute.id)?.label ?? preset.label} Model Access credential is available.`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.allSettled([
      broker?.revokeInjection?.({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId: input.appId,
          runId,
          modelRouteId: model.entry.modelRoute.id,
        },
      }),
      broker?.close?.(),
    ]);
  }
}
