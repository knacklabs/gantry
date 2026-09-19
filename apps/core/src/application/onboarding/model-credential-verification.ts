import { randomUUID } from 'node:crypto';

import { createAgentCredentialBroker } from '../../adapters/credentials/agent-credential-broker-factory.js';
import { getAgentCredentialInjection } from '../credentials/agent-credential-service.js';
import type { AppId } from '../../domain/app/app.js';
import type { AgentRunId } from '../../domain/events/events.js';
import type { ModelCredential } from '../../domain/model-credentials/model-credentials.js';
import type { ModelCredentialRepository } from '../../domain/ports/repositories.js';
import {
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
} from '../../shared/model-catalog.js';
import { getModelProviderDefinition } from '../../shared/model-provider-registry.js';
import { ONBOARDING_MODEL_PROBE_TIMEOUT_MS } from './onboarding-state-machine.js';

const PROBE_TEXT = 'Reply with exactly: GANTRY_MODEL_OK';

export async function verifyOnboardingModelCredential(input: {
  appId: AppId;
  credential: ModelCredential;
  modelAlias: string;
  timeoutMs?: number;
}): Promise<{ routeId: string; modelId: string }> {
  const selection = resolveModelSelectionForWorkload(input.modelAlias, 'chat');
  if (!selection.ok) throw new Error(selection.message);
  if (selection.entry.modelRoute.id !== input.credential.providerId) {
    throw new Error(
      'The selected model does not belong to the staged provider.',
    );
  }
  const repository = candidateRepository(input.credential);
  const broker = await createAgentCredentialBroker({
    mode: 'gantry',
    modelCredentials: repository,
  });
  if (!broker) throw new Error('Gantry Model Gateway is not available.');
  const runId = `onboarding-probe:${randomUUID()}` as AgentRunId;
  try {
    const injection = await getAgentCredentialInjection({
      mode: 'gantry',
      purpose: 'model_runtime',
      appId: input.appId,
      runId,
      modelRouteId: selection.entry.modelRoute.id,
      broker,
    });
    const provider = getModelProviderDefinition(selection.entry.modelRoute.id);
    if (!provider)
      throw new Error('The selected model provider is unavailable.');
    const baseUrl = injection.env[provider.gateway.sdkProjection.baseUrlEnv];
    const token = injection.env[provider.gateway.sdkProjection.tokenEnv];
    if (!baseUrl || !token)
      throw new Error('Model Gateway did not issue a probe binding.');
    await invokeProbe({
      baseUrl,
      token,
      entry: selection.entry,
      timeoutMs: input.timeoutMs ?? ONBOARDING_MODEL_PROBE_TIMEOUT_MS,
    });
    return {
      routeId: selection.entry.modelRoute.id,
      modelId: selection.entry.modelRoute.providerModelId,
    };
  } finally {
    await Promise.allSettled([
      broker.revokeInjection?.({
        binding: {
          profile: 'gantry',
          purpose: 'model_runtime',
          appId: input.appId,
          runId,
          modelRouteId: input.credential.providerId,
        },
      }),
      broker.close?.(),
    ]);
  }
}

async function invokeProbe(input: {
  baseUrl: string;
  token: string;
  entry: ModelCatalogEntry;
  timeoutMs: number;
}): Promise<void> {
  const anthropic = input.entry.responseFamily === 'anthropic';
  const response = await fetch(
    `${input.baseUrl.replace(/\/$/, '')}${anthropic ? '/v1/messages' : '/chat/completions'}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(input.timeoutMs),
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        ...(anthropic ? { 'anthropic-version': '2023-06-01' } : {}),
      },
      body: JSON.stringify(
        anthropic
          ? {
              model: input.entry.modelRoute.providerModelId,
              max_tokens: 16,
              messages: [{ role: 'user', content: PROBE_TEXT }],
            }
          : {
              model: input.entry.modelRoute.providerModelId,
              messages: [{ role: 'user', content: PROBE_TEXT }],
              ...(input.entry.modelRoute.id === 'openai'
                ? { max_completion_tokens: 16 }
                : { max_tokens: 16 }),
            },
      ),
    },
  );
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new Error(
      `Model probe failed with upstream status ${response.status}.`,
    );
  }
  const text = probeText(body, anthropic);
  if (!text) throw new Error('Model probe returned no text.');
}

function probeText(value: unknown, anthropic: boolean): string {
  if (!value || typeof value !== 'object') return '';
  const body = value as Record<string, unknown>;
  if (anthropic) {
    const content = Array.isArray(body.content) ? body.content : [];
    return content
      .map((item) =>
        item &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('')
      .trim();
  }
  const first = Array.isArray(body.choices) ? body.choices[0] : null;
  if (!first || typeof first !== 'object') return '';
  const message = (first as { message?: unknown }).message;
  return message &&
    typeof message === 'object' &&
    typeof (message as { content?: unknown }).content === 'string'
    ? (message as { content: string }).content.trim()
    : '';
}

function candidateRepository(
  credential: ModelCredential,
): ModelCredentialRepository {
  return {
    getModelCredential: async ({ appId, providerId }) =>
      appId === credential.appId && providerId === credential.providerId
        ? credential
        : null,
    listModelCredentials: async ({ appId }) =>
      appId === credential.appId ? [credential] : [],
    upsertModelCredential: async () => {
      throw new Error('Onboarding probe credentials are read-only.');
    },
    disableModelCredential: async () => {
      throw new Error('Onboarding probe credentials are read-only.');
    },
    deleteModelCredential: async () => {
      throw new Error('Onboarding probe credentials are read-only.');
    },
  };
}
