import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../../../../shared/neutral-ca-trust-env.js';

export { NEUTRAL_CA_TRUST_ENV_KEYS };

type BashCommandKey = 'command' | 'cmd';

const GO_DNS_RESOLVER_ENV = 'GODEBUG=netdns=go';

export function applyBashTrustEnv(
  toolName: string,
  input: Record<string, unknown>,
  sdkEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  if (toolName !== 'Bash') return input;

  const commandKey = bashCommandKey(input);
  if (!commandKey) return input;

  const command = input[commandKey];
  if (typeof command !== 'string' || !command.trim()) return input;

  const prefix = bashTrustEnvPrefix(sdkEnv.NODE_EXTRA_CA_CERTS?.trim());
  if (command.startsWith(`${prefix} `)) return input;

  return {
    ...input,
    [commandKey]: `${prefix} ${command}`,
  };
}

function bashCommandKey(input: Record<string, unknown>): BashCommandKey | null {
  if (typeof input.command === 'string') return 'command';
  if (typeof input.cmd === 'string') return 'cmd';
  return null;
}

function bashTrustEnvPrefix(caPath: string | undefined): string {
  const entries = [GO_DNS_RESOLVER_ENV];
  if (caPath) {
    const quotedCaPath = shellSingleQuote(caPath);
    entries.push(
      ...NEUTRAL_CA_TRUST_ENV_KEYS.map((key) => `${key}=${quotedCaPath}`),
    );
  }
  return entries.join(' ');
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
