import { isIP } from 'node:net';
import path from 'node:path';

import { getAgentCredentialInjection } from '../../application/credentials/agent-credential-service.js';
import { createAgentCredentialBroker } from '../credentials/agent-credential-broker-factory.js';
import {
  getModelProviderPreset,
  resolveModelSelectionForWorkload,
  type ModelProviderId,
} from '../../shared/model-catalog.js';
import { validateModelCredentialProjectionForEntry } from './anthropic-claude-agent/model-provider-credential-validation.js';
import { createExternalAgentCredentialInjection } from './external-credential-injection.js';

export interface ProviderPreflightResult {
  ok: boolean;
  status: 'pass' | 'fail' | 'skipped';
  message: string;
}

export interface ModelProviderPreflightSettings {
  credentialBroker: {
    mode: 'none' | 'onecli' | 'external';
    onecli: { url: string };
    external?: { baseUrl?: string };
  };
}

export async function preflightModelProvider(input: {
  runtimeHome: string;
  provider: ModelProviderId;
  settings: ModelProviderPreflightSettings;
}): Promise<ProviderPreflightResult> {
  const { runtimeHome, provider, settings } = input;
  const preset = getModelProviderPreset(provider);
  const model = resolveModelSelectionForWorkload(preset.chatDefault, 'chat');
  if (!model.ok) return { ok: false, status: 'fail', message: model.message };
  if (settings.credentialBroker.mode === 'external') {
    const baseUrl = resolveExternalModelBrokerBaseUrl(
      settings.credentialBroker.external?.baseUrl ?? '',
    );
    await getAgentCredentialInjection({
      mode: 'external',
      purpose: 'model_runtime',
      externalInjection: createExternalAgentCredentialInjection({
        normalizedBaseUrl: baseUrl,
      }),
    });
    return {
      ok: true,
      status: 'pass',
      message:
        'External Model Access broker is configured; credential projection will be validated at runtime.',
    };
  }
  if (settings.credentialBroker.mode !== 'onecli') {
    return {
      ok: false,
      status: 'fail',
      message: `${preset.label} requires Model Access with a configured credential broker.`,
    };
  }
  try {
    const broker = await createAgentCredentialBroker({
      mode: settings.credentialBroker.mode,
      onecliUrl: settings.credentialBroker.onecli.url,
      dataDir: path.join(runtimeHome, 'data'),
    });
    if (!broker) {
      return {
        ok: false,
        status: 'fail',
        message: 'Model Access broker is not configured.',
      };
    }
    const injection = await getAgentCredentialInjection({
      mode: 'onecli',
      purpose: 'model_runtime',
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
    if (provider === 'anthropic') {
      await assertOnecliAnthropicSecretConfigured(
        settings.credentialBroker.onecli.url,
      );
    }
    return {
      ok: true,
      status: 'pass',
      message:
        provider === 'openrouter'
          ? 'OpenRouter-scoped Model Access credential is available.'
          : `${preset.label} Model Access credential is available.`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 'fail',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function assertOnecliAnthropicSecretConfigured(
  rawOnecliUrl: string,
): Promise<void> {
  const validation = validateOnecliLocalUrl(rawOnecliUrl);
  const response = await fetch(new URL('/api/secrets', validation).toString());
  if (!response.ok) {
    throw new Error(
      `Could not verify Anthropic Model Access credentials: OneCLI returned ${response.status}.`,
    );
  }
  const secrets = (await response.json()) as unknown;
  if (!Array.isArray(secrets)) {
    throw new Error(
      'Could not verify Anthropic Model Access credentials: OneCLI returned an invalid secrets response.',
    );
  }
  const hasAnthropicSecret = secrets.some((secret) => {
    if (!secret || typeof secret !== 'object') return false;
    const item = secret as { type?: unknown; hostPattern?: unknown };
    if (item.type !== 'anthropic') return false;
    if (typeof item.hostPattern !== 'string') return true;
    const host = item.hostPattern.toLowerCase().replace(/\.+$/, '');
    return (
      host === 'api.anthropic.com' ||
      host === '*.anthropic.com' ||
      host.endsWith('.anthropic.com')
    );
  });
  if (!hasAnthropicSecret) {
    throw new Error(
      'Anthropic Model Access credential is missing. Add an Anthropic API key in Model Access before using Anthropic models.',
    );
  }
}

function validateOnecliLocalUrl(rawOnecliUrl: string): string {
  const input = rawOnecliUrl.trim();
  if (!input) throw new Error('credential_broker.onecli.url is required.');
  const parsed = new URL(input);
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(
      'Anthropic credential verification through OneCLI secrets is only supported for a loopback Model Access URL.',
    );
  }
  return parsed.toString().replace(/\/$/, '');
}

function resolveExternalModelBrokerBaseUrl(rawBrokerUrl: string): string {
  const label = 'credential_broker.external.base_url';
  const input = rawBrokerUrl.trim();
  if (!input) throw new Error(`${label} is required.`);
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${label} must not contain query parameters or fragments.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use http:// or https://.`);
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${label} must use HTTPS unless it points to loopback.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.split('.')[0] === '127';
  if (ipVersion === 6) return normalized === '::1';
  return false;
}
