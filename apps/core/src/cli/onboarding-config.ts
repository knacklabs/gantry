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

export interface OnboardingConfigInput {
  runtimeHome: string;
  postgresDatabaseUrl?: string;
  postgresSchema?: string;
  primaryProvider: 'telegram' | 'slack';
  telegramBotToken?: string;
  telegramPermissionApproverIds?: string;
  slackBotToken?: string;
  slackAppToken?: string;
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
  const settingsSeed = loadRuntimeSettings(input.runtimeHome);
  settingsSeed.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settingsSeed.storage.postgres.schema = postgresSchema;
  const settings = await loadDesiredRuntimeSettingsForWrite({
    runtimeHome: input.runtimeHome,
    settings: settingsSeed,
  });
  const previousSettings = structuredClone(settings);
  if (input.agentName?.trim()) {
    settings.agent.name = input.agentName.trim();
  }
  settings.storage.postgres.urlEnv = 'GANTRY_DATABASE_URL';
  settings.storage.postgres.schema = postgresSchema;
  let previousSettingsForFinalWrite = previousSettings;
  const storesRuntimeSecrets = Boolean(
    input.telegramBotToken?.trim() ||
    (input.slackBotToken?.trim() && input.slackAppToken?.trim()),
  );
  const restartRequired: string[] = [];
  if (storesRuntimeSecrets) {
    const result = await writeDesiredRuntimeSettings({
      runtimeHome: input.runtimeHome,
      settings,
      previousSettings,
      createdBy: 'cli:onboarding',
    });
    restartRequired.push(...(result.restartRequired ?? []));
    previousSettingsForFinalWrite = structuredClone(settings);
  }
  // Re-derive job/memory defaults only when the chat model actually changes
  // (or was never set) — maintenance runs that leave the model alone must not
  // wipe explicit job defaults or custom memory models. An absent alias means
  // "keep the configured model", never a reset to the setup default.
  const nextChatAlias =
    model.alias || settings.agent.defaultModel || DEFAULT_SETUP_MODEL_ALIAS;
  if (settings.agent.defaultModel !== nextChatAlias) {
    applyModelDefaults(settings, nextChatAlias);
  }
  if (input.agentHarness) {
    settings.agent.agentHarness = input.agentHarness;
  }
  settings.credentialBroker.mode = input.credentialMode;
  const hasTelegramBotToken = Boolean(input.telegramBotToken?.trim());
  const hasSlackTokens = Boolean(
    input.slackBotToken?.trim() && input.slackAppToken?.trim(),
  );
  // A channel that is already enabled with stored secret refs stays enabled
  // unless this run reconfigures it — maintenance runs and channel switches
  // must not silently disable a working channel.
  const preserveTelegram =
    !hasTelegramBotToken &&
    hasEnabledProviderWithStoredSecretRefs(previousSettings, 'telegram');
  const preserveSlack =
    !hasSlackTokens &&
    hasEnabledProviderWithStoredSecretRefs(previousSettings, 'slack');
  settings.providers.telegram.enabled =
    (input.primaryProvider === 'telegram' && hasTelegramBotToken) ||
    preserveTelegram;
  settings.providers.slack.enabled =
    (input.primaryProvider === 'slack' && hasSlackTokens) || preserveSlack;
  const secretWrites: Promise<void>[] = [];
  if (input.telegramBotToken?.trim()) {
    secretWrites.push(
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'TELEGRAM_BOT_TOKEN',
        value: input.telegramBotToken.trim(),
        actor: 'cli:onboarding',
      }),
    );
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
  if (input.slackBotToken?.trim() && input.slackAppToken?.trim()) {
    secretWrites.push(
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'SLACK_BOT_TOKEN',
        value: input.slackBotToken.trim(),
        actor: 'cli:onboarding',
      }),
      storeRuntimeSecretInput({
        runtimeHome: input.runtimeHome,
        name: 'SLACK_APP_TOKEN',
        value: input.slackAppToken.trim(),
        actor: 'cli:onboarding',
      }),
    );
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
    enabled: input.memoryEnabled,
    embeddings: {
      ...settings.memory.embeddings,
      enabled: input.memoryEnabled && input.embeddingsEnabled,
      provider:
        input.memoryEnabled && input.embeddingsEnabled ? 'openai' : 'disabled',
    },
    dreaming: {
      ...settings.memory.dreaming,
      enabled: input.memoryEnabled && input.dreamingEnabled,
    },
  };
  await Promise.all(secretWrites);
  const result = await writeDesiredRuntimeSettings({
    runtimeHome: input.runtimeHome,
    settings,
    previousSettings: previousSettingsForFinalWrite,
    createdBy: 'cli:onboarding',
  });
  noteRestartRequired({
    restartRequired: [
      ...new Set([...restartRequired, ...(result.restartRequired ?? [])]),
    ],
  });
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
