import { randomUUID } from 'node:crypto';

import { getAgentCredentialInjection } from '../../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../credentials/agent-credential-broker-factory.js';
import { getRuntimeStorage } from '../storage/postgres/runtime-store.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { AgentCredentialBroker } from '../../domain/ports/agent-credential-broker.js';
import {
  listModelCatalogEntries,
  resolveModelSelectionForWorkload,
} from '../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../shared/model-provider-registry.js';
import { validateModelCredentialProjectionForEntry } from './anthropic-claude-agent/model-provider-credential-validation.js';

export interface ModelProviderPreflightResult {
  ok: boolean;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
}

export interface ModelProviderPreflightSettings {
  credentialBroker: {
    mode: 'none' | 'gantry';
    gateway?: {
      bindHost: string;
    };
  };
}

export async function preflightModelProvider(input: {
  runtimeHome: string;
  providerId: string;
  chatAlias?: string;
  settings: ModelProviderPreflightSettings;
  appId?: AppId;
}): Promise<ModelProviderPreflightResult> {
  void input.runtimeHome;
  const { providerId, settings } = input;
  // The gateway broker rejects bindings without an app id; CLI callers run
  // in the single-app default scope.
  const appId = input.appId ?? ('default' as AppId);
  const provider = getModelProviderDefinition(providerId);
  const model = input.chatAlias
    ? resolveModelSelectionForWorkload(input.chatAlias, 'chat')
    : {
        ok: true as const,
        entry: listModelCatalogEntries()
          .filter(
            (entry) =>
              entry.modelRoute.id === providerId &&
              entry.supportedWorkloads.includes('chat'),
          )
          .sort((a, b) => a.id.localeCompare(b.id))[0],
      };
  if (!model.ok) return { ok: false, status: 'fail', message: model.message };
  if (!model.entry) {
    return {
      ok: false,
      status: 'fail',
      message: `Model provider ${providerId} has no chat-capable catalog entry.`,
    };
  }
  if (model.entry.modelRoute.id !== providerId) {
    return {
      ok: false,
      status: 'fail',
      message: `Model alias "${input.chatAlias}" belongs to ${model.entry.modelRoute.id}, not ${providerId}.`,
    };
  }
  if (settings.credentialBroker.mode !== 'gantry') {
    return {
      ok: false,
      status: 'fail',
      message: `${provider?.label ?? providerId} requires Gantry Model Gateway credentials.`,
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
      appId,
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
      message: `${provider?.label ?? model.entry.modelRoute.id} Model Access credential is available.`,
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
          appId,
          runId,
          modelRouteId: model.entry.modelRoute.id,
        },
      }),
      broker?.close?.(),
    ]);
  }
}
