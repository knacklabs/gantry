import type { AgentCredentialInjection } from '../../domain/models/credentials.js';

const RAW_AGENT_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
];

export function createExternalAgentCredentialInjection(input: {
  normalizedBaseUrl: string;
  hostCredentialEnv?: Record<string, string>;
}): AgentCredentialInjection {
  const env = { ...(input.hostCredentialEnv ?? {}) };
  for (const key of RAW_AGENT_CREDENTIAL_ENV_KEYS) {
    delete env[key];
  }
  env.ANTHROPIC_BASE_URL = input.normalizedBaseUrl;
  return {
    env,
    applied: true,
    brokerProfile: 'external',
  };
}
