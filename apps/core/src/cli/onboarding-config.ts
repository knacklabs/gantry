import { randomBytes } from 'node:crypto';

import { readEnvFile, upsertEnvFile } from '../config/env/file.js';
import type { HostCredentialMode } from '../config/credentials/mode.js';
import type { AgentHarness } from '../shared/agent-engine.js';
import '../channels/register-builtins.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  applyModelDefaults,
  ensureConfiguredAgent,
  loadDesiredRuntimeSettingsForWrite,
  loadRuntimeSettings,
  noteRestartRequired,
  type RuntimeSettings,
  writeDesiredRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { DEFAULT_SETUP_MODEL_ALIAS } from '../shared/model-catalog.js';
import { resolveModelSelectionForWorkloadWithFamilies } from '../shared/model-families.js';
import {
  gantryRuntimeSecretRef,
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';
import { runPostgresMigrations } from '../postgres-migrate.js';
import { storeRuntimeSecretInput } from './credentials.js';
import { DEFAULT_AGENT_FOLDER } from './main-agent.js';
import {
  readOnboardingState,
  writeOnboardingState,
} from './onboarding-state.js';

export interface OnboardingConfigInput {
  runtimeHome: string;
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
  primaryProvider: 'telegram' | 'slack';
  telegramBotToken?: string;
  hasStoredTelegramSecretRefs?: boolean;
  telegramPermissionApproverIds?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  hasStoredSlackSecretRefs?: boolean;
  slackPermissionApproverIds?: string;
  modelAlias?: string;
  agentHarness?: AgentHarness;
  credentialMode: HostCredentialMode;
  agentName?: string;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}

const REQUIRED_CHANNEL_SECRET_REFS = {
  telegram: ['bot_token'],
  slack: ['bot_token', 'app_token'],
} as const satisfies Record<
  OnboardingConfigInput['primaryProvider'],
  readonly string[]
>;

function hasEnabledProviderWithStoredSecretRefs(
  settings: RuntimeSettings,
  providerId: OnboardingConfigInput['primaryProvider'],
): boolean {
  if (!settings.providers[providerId]?.enabled) return false;
  return Object.values(settings.providerAccounts).some(
    (account) =>
      account.provider === providerId &&
      account.status !== 'disabled' &&
      REQUIRED_CHANNEL_SECRET_REFS[providerId].every((key) =>
        Boolean(account.runtimeSecretRefs[key]?.trim()),
      ),
  );
}

const CHANNEL_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_PERMISSION_APPROVER_IDS',
] as const;

const STALE_SETTINGS_MESSAGE =
  'Settings mutation is based on stale settings; reload latest desired state and retry.';
const MAX_STALE_SETTINGS_RETRIES = 3;

type ResolvedOnboardingModel = ReturnType<typeof resolveOnboardingModel>;
type OnboardingWriteResult = Awaited<
  ReturnType<typeof writeDesiredRuntimeSettings>
>;
type ChannelProviderId = OnboardingConfigInput['primaryProvider'];

function enabledProviderEnvSecretNames(settings: RuntimeSettings): Set<string> {
  const names = new Set<string>();
  for (const account of Object.values(settings.providerAccounts)) {
    if (account.status === 'disabled') continue;
    if (!settings.providers[account.provider]?.enabled) continue;
    for (const [key, value] of Object.entries(account.runtimeSecretRefs)) {
      const ref = value?.trim();
      if (!ref) continue;
      const normalized = normalizeRuntimeSecretRefString(
        ref,
        `provider account ${account.provider} secret ref ${key}`,
      );
      const parsed = parseRuntimeSecretRefString(normalized);
      if (parsed.source === 'env') names.add(parsed.name);
    }
  }
  return names;
}

export async function persistOnboardingConfig(
  input: OnboardingConfigInput,
): Promise<void> {
  ensureRuntimeLayout(input.runtimeHome);

  const envPath = envFilePath(input.runtimeHome);
  const existingEnv = readEnvFile(envPath);
  const existingCredentialSecret =
    existingEnv.SECRET_ENCRYPTION_KEY?.trim() ||
    process.env.SECRET_ENCRYPTION_KEY?.trim() ||
    '';
  const credentialSecretEncryptionKey = isValidCredentialEncryptionKey(
    existingCredentialSecret,
  )
    ? existingCredentialSecret
    : randomBytes(32).toString('base64');

  upsertEnvFile(envPath, {
    CLAUDE_CODE_OAUTH_TOKEN: null,
    ANTHROPIC_API_KEY: null,
    ANTHROPIC_AUTH_TOKEN: null,
    ANTHROPIC_MODEL: null,
    ANTHROPIC_DEFAULT_OPUS_MODEL: null,
    ANTHROPIC_DEFAULT_SONNET_MODEL: null,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: null,
    GANTRY_DATABASE_URL: input.postgresDatabaseUrl?.trim() || null,
    SECRET_ENCRYPTION_KEY: input.postgresDatabaseUrl?.trim()
      ? credentialSecretEncryptionKey
      : null,
    OPENAI_API_KEY: null,
  });
  if (input.postgresDatabaseUrl?.trim()) {
    process.env.GANTRY_DATABASE_URL = input.postgresDatabaseUrl.trim();
    process.env.SECRET_ENCRYPTION_KEY = credentialSecretEncryptionKey;
  }

  const model = resolveOnboardingModel(input.modelAlias);
  const postgresSchema = input.postgresSchema?.trim() || 'gantry';
  if (input.postgresDatabaseUrl?.trim()) {
    await runPostgresMigrations({
      url: input.postgresDatabaseUrl.trim(),
      schema: postgresSchema,
    });
  }
  const { settings, result } = await writeOnboardingSettingsWithRetry({
    config: input,
    model,
    postgresSchema,
  });
  noteRestartRequired(result);
  const envSecretRefs = enabledProviderEnvSecretNames(settings);
  upsertEnvFile(
    envPath,
    Object.fromEntries(
      CHANNEL_ENV_KEYS.filter((key) => !envSecretRefs.has(key)).map((key) => [
        key,
        null,
      ]),
    ),
  );
}

async function writeOnboardingSettingsWithRetry(input: {
  config: OnboardingConfigInput;
  model: ResolvedOnboardingModel;
  postgresSchema: string;
}): Promise<{ settings: RuntimeSettings; result: OnboardingWriteResult }> {
  let secretsStored = false;
  for (let attempt = 0; attempt <= MAX_STALE_SETTINGS_RETRIES; attempt += 1) {
    const previousSettings = await loadOnboardingSettingsBase(
      input.config,
      input.postgresSchema,
    );
    const settings = buildOnboardingSettings({
      config: input.config,
      baseSettings: previousSettings,
      model: input.model,
      postgresSchema: input.postgresSchema,
    });
    if (!secretsStored) {
      const storedProviders = await storeOnboardingRuntimeSecrets(
        input.config,
        settings,
      );
      markOnboardingRuntimeSecretsStored(
        input.config.runtimeHome,
        storedProviders,
      );
      secretsStored = true;
    }
    try {
      const result = await writeDesiredRuntimeSettings({
        runtimeHome: input.config.runtimeHome,
        settings,
        previousSettings,
        createdBy: 'cli:onboarding',
      });
      return { settings, result };
    } catch (err) {
      if (
        !isStaleSettingsWriteError(err) ||
        attempt === MAX_STALE_SETTINGS_RETRIES
      ) {
        throw err;
      }
    }
  }
  throw new Error(STALE_SETTINGS_MESSAGE);
}

async function loadOnboardingSettingsBase(
  input: OnboardingConfigInput,
  postgresSchema: string,
): Promise<RuntimeSettings> {
  const settingsSeed = loadRuntimeSettings(input.runtimeHome);
  settingsSeed.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settingsSeed.storage.postgres.schema = postgresSchema;
  return loadDesiredRuntimeSettingsForWrite({
    runtimeHome: input.runtimeHome,
    settings: settingsSeed,
  });
}

function buildOnboardingSettings(input: {
  config: OnboardingConfigInput;
  baseSettings: RuntimeSettings;
  model: ResolvedOnboardingModel;
  postgresSchema: string;
}): RuntimeSettings {
  const settings = structuredClone(input.baseSettings);
  if (input.config.agentName?.trim()) {
    settings.agent.name = input.config.agentName.trim();
  }
  settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settings.storage.postgres.schema = input.postgresSchema;
  // Re-derive job/memory defaults only when the chat model actually changes
  // (or was never set) — maintenance runs that leave the model alone must not
  // wipe explicit job defaults or custom memory models. An absent alias means
  // "keep the configured model", never a reset to the setup default.
  const nextChatAlias =
    input.model.alias ||
    settings.agent.defaultModel ||
    DEFAULT_SETUP_MODEL_ALIAS;
  if (settings.agent.defaultModel !== nextChatAlias) {
    applyModelDefaults(settings, nextChatAlias);
  }
  if (input.config.agentHarness) {
    settings.agent.agentHarness = input.config.agentHarness;
  }
  settings.credentialBroker.mode = input.config.credentialMode;
  const hasTelegramBotToken = Boolean(input.config.telegramBotToken?.trim());
  const hasSlackTokens = Boolean(
    input.config.slackBotToken?.trim() && input.config.slackAppToken?.trim(),
  );
  const useStoredTelegramSecretRefs = Boolean(
    input.config.primaryProvider === 'telegram' &&
    input.config.hasStoredTelegramSecretRefs,
  );
  const useStoredSlackSecretRefs = Boolean(
    input.config.primaryProvider === 'slack' &&
    input.config.hasStoredSlackSecretRefs,
  );
  // A channel that is already enabled with stored secret refs stays enabled
  // unless this run reconfigures it — maintenance runs and channel switches
  // must not silently disable a working channel.
  const preserveTelegram =
    !hasTelegramBotToken &&
    hasEnabledProviderWithStoredSecretRefs(input.baseSettings, 'telegram');
  const preserveSlack =
    !hasSlackTokens &&
    hasEnabledProviderWithStoredSecretRefs(input.baseSettings, 'slack');
  settings.providers.telegram.enabled =
    (input.config.primaryProvider === 'telegram' &&
      (hasTelegramBotToken || useStoredTelegramSecretRefs)) ||
    preserveTelegram;
  settings.providers.slack.enabled =
    (input.config.primaryProvider === 'slack' &&
      (hasSlackTokens || useStoredSlackSecretRefs)) ||
    preserveSlack;
  if (input.config.telegramBotToken?.trim() || useStoredTelegramSecretRefs) {
    ensureConfiguredAgent(settings, {
      agentId: DEFAULT_AGENT_FOLDER,
      agentName: settings.agent.name,
      agentFolder: DEFAULT_AGENT_FOLDER,
    });
    settings.providerAccounts.telegram_default = {
      agentId: DEFAULT_AGENT_FOLDER,
      provider: 'telegram',
      label:
        settings.providerAccounts.telegram_default?.label || 'Telegram Default',
      runtimeSecretRefs: {
        ...(settings.providerAccounts.telegram_default?.runtimeSecretRefs ||
          {}),
        bot_token: gantryRuntimeSecretRef('TELEGRAM_BOT_TOKEN'),
      },
    };
  }
  if (
    (input.config.slackBotToken?.trim() &&
      input.config.slackAppToken?.trim()) ||
    useStoredSlackSecretRefs
  ) {
    ensureConfiguredAgent(settings, {
      agentId: DEFAULT_AGENT_FOLDER,
      agentName: settings.agent.name,
      agentFolder: DEFAULT_AGENT_FOLDER,
    });
    settings.providerAccounts.slack_default = {
      agentId: DEFAULT_AGENT_FOLDER,
      provider: 'slack',
      label: settings.providerAccounts.slack_default?.label || 'Slack Default',
      runtimeSecretRefs: {
        ...(settings.providerAccounts.slack_default?.runtimeSecretRefs || {}),
        bot_token: gantryRuntimeSecretRef('SLACK_BOT_TOKEN'),
        app_token: gantryRuntimeSecretRef('SLACK_APP_TOKEN'),
      },
    };
  }
  settings.memory = {
    ...settings.memory,
    enabled: input.config.memoryEnabled,
    embeddings: {
      ...settings.memory.embeddings,
      enabled: input.config.memoryEnabled && input.config.embeddingsEnabled,
      provider:
        input.config.memoryEnabled && input.config.embeddingsEnabled
          ? 'openai'
          : 'disabled',
    },
    dreaming: {
      ...settings.memory.dreaming,
      enabled: input.config.memoryEnabled && input.config.dreamingEnabled,
    },
  };
  return settings;
}

async function storeOnboardingRuntimeSecrets(
  input: OnboardingConfigInput,
  runtimeSettings: RuntimeSettings,
): Promise<ChannelProviderId[]> {
  const storedProviders: ChannelProviderId[] = [];
  if (input.telegramBotToken?.trim()) {
    await storeRuntimeSecretInput({
      runtimeHome: input.runtimeHome,
      name: 'TELEGRAM_BOT_TOKEN',
      value: input.telegramBotToken.trim(),
      actor: 'cli:onboarding',
      runtimeSettings,
    });
    storedProviders.push('telegram');
  }
  if (input.slackBotToken?.trim() && input.slackAppToken?.trim()) {
    await Promise.all([
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'SLACK_BOT_TOKEN',
        value: input.slackBotToken.trim(),
        actor: 'cli:onboarding',
        runtimeSettings,
      }),
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'SLACK_APP_TOKEN',
        value: input.slackAppToken.trim(),
        actor: 'cli:onboarding',
        runtimeSettings,
      }),
    ]);
    storedProviders.push('slack');
  }
  return storedProviders;
}

function markOnboardingRuntimeSecretsStored(
  runtimeHome: string,
  providers: readonly ChannelProviderId[],
): void {
  if (providers.length === 0) return;
  const state = readOnboardingState(runtimeHome);
  if (!state || state.status !== 'in_progress') return;
  const storedProviderSecretRefs = new Set(
    state.data.storedProviderSecretRefs ?? [],
  );
  for (const provider of providers) {
    storedProviderSecretRefs.add(provider);
  }
  state.data.storedProviderSecretRefs = [...storedProviderSecretRefs];
  writeOnboardingState(runtimeHome, state);
}

function isStaleSettingsWriteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'SettingsRevisionConflictError' ||
    err.message.includes(STALE_SETTINGS_MESSAGE) ||
    err.message.includes('settings revision conflicted:')
  );
}

export async function prepareOnboardingCredentialStorage(input: {
  runtimeHome: string;
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
}): Promise<void> {
  const postgresUrl = input.postgresDatabaseUrl?.trim();
  if (!postgresUrl) return;
  const postgresSchema = input.postgresSchema?.trim() || 'gantry';
  ensureRuntimeLayout(input.runtimeHome);
  const envPath = envFilePath(input.runtimeHome);
  const existingEnv = readEnvFile(envPath);
  const existingCredentialKey =
    existingEnv.SECRET_ENCRYPTION_KEY?.trim() ||
    process.env.SECRET_ENCRYPTION_KEY?.trim() ||
    '';
  const credentialKey = isValidCredentialEncryptionKey(existingCredentialKey)
    ? existingCredentialKey
    : randomBytes(32).toString('base64');
  upsertEnvFile(envPath, {
    GANTRY_DATABASE_URL: postgresUrl,
    GANTRY_SETTINGS_POSTGRES_SCHEMA: postgresSchema,
    SECRET_ENCRYPTION_KEY: credentialKey,
  });
  process.env.GANTRY_HOME = input.runtimeHome;
  process.env.GANTRY_DATABASE_URL = postgresUrl;
  process.env.GANTRY_SETTINGS_POSTGRES_SCHEMA = postgresSchema;
  process.env.SECRET_ENCRYPTION_KEY = credentialKey;
  await runPostgresMigrations({
    url: postgresUrl,
    schema: postgresSchema,
  });
}

function isValidCredentialEncryptionKey(raw: string): boolean {
  if (!raw) return false;
  return Buffer.from(raw, 'base64').length === 32;
}

function resolveOnboardingModel(value: string | undefined): {
  alias: string;
} {
  const trimmed = value?.trim();
  if (!trimmed) return { alias: '' };
  // Family-aware: maintenance runs carry the stored chat alias through the
  // draft, and a family selection (gpt-oss) must survive a non-model edit
  // verbatim instead of being rejected or reset.
  const resolved = resolveModelSelectionForWorkloadWithFamilies(
    trimmed,
    'chat',
  );
  if (!resolved.ok) {
    throw new Error(resolved.message);
  }
  return { alias: resolved.alias };
}
