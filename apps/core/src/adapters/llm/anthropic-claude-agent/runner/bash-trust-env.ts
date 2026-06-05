import { NEUTRAL_CA_TRUST_ENV_KEYS } from '../../../../shared/neutral-ca-trust-env.js';

export { NEUTRAL_CA_TRUST_ENV_KEYS };

type BashCommandKey = 'command' | 'cmd';

const GO_DNS_RESOLVER_ENV = 'GODEBUG=netdns=go';
const TOOL_NETWORK_COMMAND_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'FTP_PROXY',
  'ftp_proxy',
  'RSYNC_PROXY',
  'DOCKER_HTTP_PROXY',
  'DOCKER_HTTPS_PROXY',
  'CLOUDSDK_PROXY_TYPE',
  'CLOUDSDK_PROXY_ADDRESS',
  'CLOUDSDK_PROXY_PORT',
  'GRPC_PROXY',
  'grpc_proxy',
  'GIT_SSH_COMMAND',
  'NODE_USE_ENV_PROXY',
  'NO_PROXY',
  'no_proxy',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
] as const;

export function applyBashTrustEnv(
  toolName: string,
  input: Record<string, unknown>,
  toolNetworkEnv: Record<string, string | undefined>,
): Record<string, unknown> {
  if (toolName !== 'Bash' && toolName !== 'RunCommand') return input;

  const commandKey = bashCommandKey(input);
  if (!commandKey) return input;

  const command = input[commandKey];
  if (typeof command !== 'string' || !command.trim()) return input;

  const prefix = bashTrustEnvPrefix(toolNetworkEnv);
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

function bashTrustEnvPrefix(
  toolNetworkEnv: Record<string, string | undefined>,
): string {
  const entries = [GO_DNS_RESOLVER_ENV];
  for (const key of TOOL_NETWORK_COMMAND_ENV_KEYS) {
    const value = toolNetworkEnv[key]?.trim();
    if (!value) continue;
    entries.push(`${key}=${shellSingleQuote(value)}`);
  }
  return entries.join(' ');
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
