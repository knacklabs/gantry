import type { AgentCredentialInjection } from '../../../domain/models/credentials.js';
import {
  isOpenRouterModelRoute,
  type ModelCatalogEntry,
} from '../../../shared/model-catalog.js';

export function validateModelCredentialProjectionForEntry(input: {
  model: ModelCatalogEntry;
  projection: Pick<AgentCredentialInjection, 'env' | 'credentialProviders'> & {
    brokerProfile?: string;
  };
}): void {
  const { model, projection } = input;
  const isExternalBrokerProjection = projection.brokerProfile === 'external';
  const isOpenRouterRoute = isOpenRouterModelRoute(model);
  if (
    isOpenRouterRoute &&
    !isExternalBrokerProjection &&
    (!projection.env.ANTHROPIC_AUTH_TOKEN ||
      projection.credentialProviders?.ANTHROPIC_AUTH_TOKEN !== 'openrouter')
  ) {
    throw new Error(
      `OpenRouter model ${model.displayName} requires an OpenRouter-scoped credential from Model Access. Configure Model Access/OpenRouter credentials before selecting this model.`,
    );
  }
  if (
    !isOpenRouterRoute &&
    (projection.credentialProviders?.ANTHROPIC_AUTH_TOKEN === 'openrouter' ||
      isOpenRouterBaseUrl(projection.env.ANTHROPIC_BASE_URL))
  ) {
    throw new Error(
      `Model ${model.displayName} is configured for ${model.modelRoute.label}, but AgentCredentialBroker returned OpenRouter-scoped Anthropic SDK credentials. Switch the session/job model to kimi or configure ${model.modelRoute.label} credentials for this model.`,
    );
  }
  if (
    model.modelRoute.id === 'anthropic' &&
    !isExternalBrokerProjection &&
    !projection.env.ANTHROPIC_AUTH_TOKEN &&
    !projection.env.ANTHROPIC_API_KEY &&
    !projection.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    throw new Error(
      `Anthropic model ${model.displayName} requires Anthropic credentials from Model Access. Add an Anthropic API key in Model Access before selecting this model.`,
    );
  }
}

export function isOpenRouterBaseUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}
