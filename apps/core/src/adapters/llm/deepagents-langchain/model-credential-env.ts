// DeepAgents model credential env allowlist. Only these keys reach the runner,
// and only via runnerInputPatch.modelCredentialEnv (never toolNetworkEnv). The
// OpenAI lane uses OPENAI_BASE_URL/OPENAI_API_KEY; the Anthropic API-key lane
// uses ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY. NODE_EXTRA_CA_CERTS rides along so
// the LangChain HTTP clients can verify the loopback gateway under custom CA
// trust. All values are run-scoped Gantry gateway tokens, never raw provider
// secrets.
const DEEPAGENTS_MODEL_CREDENTIAL_ENV_KEYS = new Set([
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'NODE_EXTRA_CA_CERTS',
]);

export function projectDeepAgentModelCredentialEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      DEEPAGENTS_MODEL_CREDENTIAL_ENV_KEYS.has(key) &&
      typeof value === 'string'
    ) {
      env[key] = value;
    }
  }
  return env;
}
