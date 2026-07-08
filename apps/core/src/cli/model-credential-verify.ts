import {
  injectProviderAuth,
  resolveGatewayUpstream,
} from '../adapters/llm/anthropic-claude-agent/gantry-model-gateway-routing.js';
import {
  getModelProviderDefinition,
  type ModelCredentialPayload,
} from '../shared/model-provider-registry.js';
import { getProviderRuntimeSecret } from '../channels/provider-runtime-secrets.js';
import { createRepositoryRuntimeSecretProvider } from '../adapters/credentials/repository-runtime-secret-provider.js';
import type { AppId } from '../domain/app/app.js';
import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';
import { validateSlackAppToken, validateSlackBotToken } from './slack.js';
import { validateTelegramBotToken } from './telegram.js';
import { resolveTelegramTokenForDoctor } from './telegram-doctor-token.js';
import { resolveRuntimeEnvValue } from './runtime-credential-check.js';
import type { DoctorCheck } from './doctor.js';

export type ModelProviderCredentialLiveCheck =
  | { ok: true }
  | { ok: false; message: string }
  | { skipped: true; reason: string };

type RuntimeSettingsForLiveCredentialCheck = {
  providers: Record<string, { enabled: boolean } | undefined>;
  providerAccounts?: Record<
    string,
    | {
        provider: string;
        runtimeSecretRefs: Record<string, string | undefined>;
      }
    | undefined
  >;
};

export async function verifyModelProviderCredentialLive(input: {
  providerId: string;
  authMode: string;
  payload: ModelCredentialPayload;
  timeoutMs?: number;
}): Promise<ModelProviderCredentialLiveCheck> {
  const provider = getModelProviderDefinition(input.providerId);
  if (!provider) {
    return {
      ok: false,
      message: `Unsupported model provider: ${input.providerId}.`,
    };
  }
  if (provider.id === 'bedrock' || provider.id === 'vertex') {
    return {
      skipped: true,
      reason: `${provider.label} live credential verification is not supported yet.`,
    };
  }
  if (provider.id === 'anthropic' && input.authMode !== 'api_key') {
    return {
      skipped: true,
      reason:
        'Anthropic Claude Code OAuth live credential verification is not supported yet.',
    };
  }

  const upstream = resolveGatewayUpstream(
    provider,
    input.authMode,
    input.payload,
  );
  const upstreamUrl = credentialProbeUrl(provider.id, upstream);
  const headers: Record<string, string> =
    provider.id === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {};

  try {
    await injectProviderAuth({
      headers,
      provider,
      authMode: input.authMode,
      payload: input.payload,
      method: 'GET',
      upstreamUrl,
      body: Buffer.alloc(0),
    });
    const response = await fetch(upstreamUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
    if (response.ok) return { ok: true };

    const body = await readErrorSnippet(response);
    const message = `${provider.label} credential verification failed with HTTP ${response.status}${
      body ? `: ${body}` : '.'
    }`;
    return { ok: false, message };
  } catch (error) {
    const timedOut =
      error instanceof DOMException && error.name === 'TimeoutError';
    return {
      ok: false,
      message: `${provider.label} credential verification ${
        timedOut ? 'timed out and ' : ''
      }could not reach provider. Check network access and retry.`,
    };
  }
}

export async function inspectSlackTokenLiveCheck(input: {
  settings: RuntimeSettingsForLiveCredentialCheck;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<DoctorCheck | null> {
  if (!input.settings.providers.slack?.enabled) return null;
  const [botToken, appToken] = await Promise.all([
    resolveProviderSecretForDoctor({
      providerId: 'slack',
      key: 'bot_token',
      defaultEnvName: 'SLACK_BOT_TOKEN',
      settings: input.settings,
      env: input.env,
    }),
    resolveProviderSecretForDoctor({
      providerId: 'slack',
      key: 'app_token',
      defaultEnvName: 'SLACK_APP_TOKEN',
      settings: input.settings,
      env: input.env,
    }),
  ]);
  if (botToken.token && appToken.token) {
    const [botValidation, appValidation] = await Promise.all([
      validateSlackBotToken(botToken.token, input.timeoutMs),
      validateSlackAppToken(appToken.token, input.timeoutMs),
    ]);
    if (botValidation.ok && appValidation.ok) {
      return {
        id: 'slack-token-api',
        title: 'Slack Token API Validation',
        status: 'pass',
        message: 'Slack bot/app tokens validated.',
      };
    }
    const failed = [botValidation, appValidation].filter((item) => !item.ok);
    const nextAction =
      failed.find((item) => item.nextAction)?.nextAction ||
      'Run `gantry provider connect slack` to refresh Slack tokens.';
    return {
      id: 'slack-token-api',
      title: 'Slack Token API Validation',
      status: 'warn',
      message: failed.map((item) => item.message).join(' '),
      nextAction,
      action: { type: 'connect_provider', label: nextAction },
    };
  }
  if (!botToken.unresolvedStoredRef && !appToken.unresolvedStoredRef) {
    return null;
  }
  const nextAction =
    'Run `gantry provider connect slack` to refresh Slack tokens.';
  return {
    id: 'slack-token-api',
    title: 'Slack Token API Validation',
    status: 'warn',
    message:
      'Slack token references are configured but secret values could not be resolved.',
    nextAction,
    action: { type: 'connect_provider', label: nextAction },
  };
}

export async function inspectTelegramTokenLiveCheck(input: {
  settings: RuntimeSettingsForLiveCredentialCheck;
  env: Record<string, string>;
  timeoutMs?: number;
}): Promise<DoctorCheck | null> {
  if (!input.settings.providers.telegram?.enabled) return null;
  const token = await resolveTelegramTokenForDoctor(input);
  if (token.token) {
    const validation = await validateTelegramBotToken(
      token.token,
      input.timeoutMs,
    );
    if (validation.ok) {
      return {
        id: 'telegram-token-api',
        title: 'Telegram Token API Validation',
        status: 'pass',
        message: validation.message,
      };
    }
    const nextAction =
      validation.nextAction || 'Refresh TELEGRAM_BOT_TOKEN and rerun doctor.';
    return {
      id: 'telegram-token-api',
      title: 'Telegram Token API Validation',
      status: 'warn',
      message: validation.message,
      nextAction,
      action: { type: 'connect_provider', label: nextAction },
    };
  }
  if (!token.unresolvedStoredRef) return null;
  const nextAction =
    'Run `gantry provider connect telegram` to refresh the Telegram token.';
  return {
    id: 'telegram-token-api',
    title: 'Telegram Token API Validation',
    status: 'warn',
    message:
      'Telegram token reference is configured but the secret value could not be resolved.',
    nextAction,
    action: { type: 'connect_provider', label: nextAction },
  };
}

function credentialProbeUrl(
  providerId: string,
  upstream: { origin: string; pathPrefix: string },
): URL {
  if (providerId === 'anthropic') return new URL('/v1/models', upstream.origin);
  if (providerId === 'openrouter')
    return new URL('/api/v1/key', upstream.origin);
  const prefix =
    providerId === 'openai' && !upstream.pathPrefix
      ? '/v1'
      : upstream.pathPrefix;
  return new URL(`${normalizePrefix(prefix)}/models`, upstream.origin);
}

function normalizePrefix(prefix: string): string {
  const value = prefix.trim().replace(/\/+$/, '');
  return value ? (value.startsWith('/') ? value : `/${value}`) : '';
}

async function readErrorSnippet(response: Response): Promise<string> {
  try {
    return (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

type RuntimeSecretDoctorStorage = {
  runtimeEventNotifier?: { close: () => Promise<void> };
  service?: { close: () => Promise<void> };
  repositories: {
    capabilitySecrets: Parameters<
      typeof createRepositoryRuntimeSecretProvider
    >[0]['repository'];
  };
};

async function resolveProviderSecretForDoctor(input: {
  providerId: string;
  key: string;
  defaultEnvName: string;
  settings: RuntimeSettingsForLiveCredentialCheck;
  env: Record<string, string>;
}): Promise<{ token: string; unresolvedStoredRef: boolean }> {
  const accountEntry = Object.entries(
    input.settings.providerAccounts ?? {},
  ).find(([, account]) => account?.provider === input.providerId);
  const providerAccountId = accountEntry?.[0];
  const ref = accountEntry?.[1]?.runtimeSecretRefs[input.key];
  if (!ref?.trim()) {
    return {
      token: resolveRuntimeEnvValue(input.env, input.defaultEnvName),
      unresolvedStoredRef: false,
    };
  }
  let parsed: ReturnType<typeof parseRuntimeSecretRefString>;
  try {
    parsed = parseRuntimeSecretRefString(normalizeRuntimeSecretRefString(ref));
  } catch {
    return { token: '', unresolvedStoredRef: true };
  }
  if (parsed.source === 'env') {
    return {
      token: resolveRuntimeEnvValue(input.env, parsed.name),
      unresolvedStoredRef: false,
    };
  }

  let storage: RuntimeSecretDoctorStorage | undefined;
  try {
    const { createStorageRuntime } =
      await import('../adapters/storage/postgres/factory.js');
    storage = createStorageRuntime() as RuntimeSecretDoctorStorage;
    const token = await getProviderRuntimeSecret({
      providerId: input.providerId,
      providerAccountId,
      key: input.key,
      defaultEnvName: input.defaultEnvName,
      settings: input.settings,
      secrets: createRepositoryRuntimeSecretProvider({
        appId: 'default' as AppId,
        repository: storage.repositories.capabilitySecrets,
      }),
    });
    return { token, unresolvedStoredRef: !token };
  } catch {
    return { token: '', unresolvedStoredRef: true };
  } finally {
    await storage?.runtimeEventNotifier?.close().catch(() => undefined);
    await storage?.service?.close().catch(() => undefined);
  }
}
