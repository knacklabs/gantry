import { readEnvFile } from './env/file.js';
import { envFilePath } from './settings/runtime-home.js';

export type ConfigSourceLane =
  | 'runtime-secret'
  | 'non-secret-setting'
  | 'agent-credential'
  | 'broker-safe-injection';

export interface ClassifiedConfigKey {
  key: string;
  lane: ConfigSourceLane;
  destination: string;
  message: string;
}

const CLASSIFIED_KEYS: Record<string, ClassifiedConfigKey> = {
  MYCLAW_DATABASE_URL: runtimeSecret('MYCLAW_DATABASE_URL'),
  TELEGRAM_BOT_TOKEN: runtimeSecret('TELEGRAM_BOT_TOKEN'),
  SLACK_BOT_TOKEN: runtimeSecret('SLACK_BOT_TOKEN'),
  SLACK_APP_TOKEN: runtimeSecret('SLACK_APP_TOKEN'),
  TEAMS_CLIENT_ID: runtimeSecret('TEAMS_CLIENT_ID'),
  TEAMS_CLIENT_SECRET: runtimeSecret('TEAMS_CLIENT_SECRET'),
  TEAMS_TENANT_ID: runtimeSecret('TEAMS_TENANT_ID'),
  MYCLAW_IPC_AUTH_SECRET: runtimeSecret('MYCLAW_IPC_AUTH_SECRET'),
  ONECLI_DATABASE_URL: runtimeSecret('ONECLI_DATABASE_URL'),
  SECRET_ENCRYPTION_KEY: runtimeSecret('SECRET_ENCRYPTION_KEY'),

  MYCLAW_CREDENTIAL_MODE: setting(
    'MYCLAW_CREDENTIAL_MODE',
    'settings.yaml credential_broker.mode',
  ),
  ONECLI_URL: setting(
    'ONECLI_URL',
    'settings.yaml credential_broker.onecli.url',
  ),
  ANTHROPIC_BASE_URL: setting(
    'ANTHROPIC_BASE_URL',
    'settings.yaml credential_broker.external.base_url',
  ),
  SLACK_PERMISSION_APPROVER_IDS: setting(
    'SLACK_PERMISSION_APPROVER_IDS',
    'settings.yaml conversations.<id>.control_approvers',
  ),
  ASSISTANT_NAME: setting('ASSISTANT_NAME', 'settings.yaml agent.name'),
  ANTHROPIC_MODEL: setting(
    'ANTHROPIC_MODEL',
    'settings.yaml agent.default_model',
  ),
  ANTHROPIC_DEFAULT_OPUS_MODEL: setting(
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'settings.yaml agent.default_model or Claude Code defaults',
  ),
  ANTHROPIC_DEFAULT_SONNET_MODEL: setting(
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'settings.yaml agent.default_model or Claude Code defaults',
  ),
  ANTHROPIC_DEFAULT_HAIKU_MODEL: setting(
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'settings.yaml agent.default_model or Claude Code defaults',
  ),
  OPENAI_DAILY_EMBED_LIMIT: setting(
    'OPENAI_DAILY_EMBED_LIMIT',
    'settings.yaml memory.embeddings.daily_limit',
  ),
  MEMORY_EXTRACTOR_MAX_FACTS: setting(
    'MEMORY_EXTRACTOR_MAX_FACTS',
    'settings.yaml memory.llm.extractor_max_facts',
  ),
  MEMORY_EXTRACTOR_MIN_CONFIDENCE: setting(
    'MEMORY_EXTRACTOR_MIN_CONFIDENCE',
    'settings.yaml memory.llm.extractor_min_confidence',
  ),
  MEMORY_DREAMING_CRON: setting(
    'MEMORY_DREAMING_CRON',
    'settings.yaml memory.dreaming.cron',
  ),
  MEMORY_EMBED_BATCH_SIZE: setting(
    'MEMORY_EMBED_BATCH_SIZE',
    'settings.yaml memory.embeddings.batch_size',
  ),
  MEMORY_MAINTENANCE_MAX_PENDING: setting(
    'MEMORY_MAINTENANCE_MAX_PENDING',
    'settings.yaml memory.maintenance.max_pending',
  ),

  ANTHROPIC_API_KEY: agentCredential('ANTHROPIC_API_KEY'),
  ANTHROPIC_AUTH_TOKEN: agentCredential('ANTHROPIC_AUTH_TOKEN'),
  CLAUDE_CODE_OAUTH_TOKEN: agentCredential('CLAUDE_CODE_OAUTH_TOKEN'),
  OPENAI_API_KEY: agentCredential('OPENAI_API_KEY'),
  OPENAI_ORG_ID: agentCredential('OPENAI_ORG_ID'),
  OPENAI_PROJECT: agentCredential('OPENAI_PROJECT'),
};

export const AGENT_CREDENTIAL_ENV_KEYS = Object.freeze(
  Object.values(CLASSIFIED_KEYS)
    .filter((entry) => entry.lane === 'agent-credential')
    .map((entry) => entry.key),
);

function runtimeSecret(key: string): ClassifiedConfigKey {
  return {
    key,
    lane: 'runtime-secret',
    destination: 'RuntimeSecretProvider',
    message: `${key} is a runtime-owned secret and may be stored in MyClaw .env for local/personal mode.`,
  };
}

function setting(key: string, destination: string): ClassifiedConfigKey {
  return {
    key,
    lane: 'non-secret-setting',
    destination,
    message: `${key} is non-secret configuration and must be configured in ${destination}, not MyClaw .env.`,
  };
}

function agentCredential(key: string): ClassifiedConfigKey {
  return {
    key,
    lane: 'agent-credential',
    destination: 'AgentCredentialBroker',
    message: `${key} is an agent-accessed credential and must be configured through Model Access or the selected enterprise credential broker, not MyClaw .env.`,
  };
}

export interface RuntimeEnvPolicyViolation {
  key: string;
  lane: ConfigSourceLane;
  message: string;
  destination: string;
}

export interface RuntimeEnvPolicyResult {
  ok: boolean;
  violations: RuntimeEnvPolicyViolation[];
}

export function classifyConfigKey(
  key: string,
): ClassifiedConfigKey | undefined {
  return CLASSIFIED_KEYS[key];
}

export function validateRuntimeEnvPolicy(
  env: Partial<Record<string, string | undefined>>,
  source = 'MyClaw .env',
): RuntimeEnvPolicyResult {
  const violations: RuntimeEnvPolicyViolation[] = [];
  for (const [key, rawValue] of Object.entries(env)) {
    if (!rawValue?.trim()) continue;
    const classified = classifyConfigKey(key);
    if (
      classified?.lane === 'agent-credential' ||
      classified?.lane === 'non-secret-setting'
    ) {
      violations.push({
        key,
        lane: classified.lane,
        message: classified.message.replace('MyClaw .env', source),
        destination: classified.destination,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

export function validateRuntimeHomeEnvPolicy(
  runtimeHome: string,
): RuntimeEnvPolicyResult {
  return validateRuntimeEnvPolicy(readEnvFile(envFilePath(runtimeHome)));
}
