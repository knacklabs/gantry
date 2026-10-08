import { NEUTRAL_CA_TRUST_ENV_KEYS } from './neutral-ca-trust-env.js';

const CHILD_NETWORK_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'GRPC_PROXY',
  'grpc_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'GODEBUG',
  'GANTRY_EGRESS_PROXY_URL',
  'NODE_EXTRA_CA_CERTS',
  ...NEUTRAL_CA_TRUST_ENV_KEYS,
] as const;

const CHILD_POSIX_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'SHELL',
  'TERM',
] as const;

// Network values may come from a host projection rather than the runner's
// ambient environment, which also carries model and IPC credentials.
export function buildChildCommandEnv(
  posixSource: NodeJS.ProcessEnv,
  networkSource: NodeJS.ProcessEnv | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_NETWORK_ENV_KEYS) {
    const value = networkSource?.[key];
    if (typeof value === 'string') env[key] = value;
  }
  for (const key of CHILD_POSIX_ENV_KEYS) {
    const value = posixSource[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}
