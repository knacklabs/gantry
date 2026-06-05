import { applyAgentEgressNoProxyEnv } from './no-proxy.js';
import { applyNeutralCaTrustAliases } from './neutral-ca-trust-env.js';

export interface ToolNetworkEnvInput {
  proxyUrl: string;
  caBundlePath?: string;
  noProxy?: {
    NO_PROXY?: string;
    no_proxy?: string;
  };
}

export function buildToolNetworkEnv(
  input: ToolNetworkEnvInput,
): Record<string, string> {
  const env: Record<string, string | undefined> = {
    HTTP_PROXY: input.proxyUrl,
    HTTPS_PROXY: input.proxyUrl,
    http_proxy: input.proxyUrl,
    https_proxy: input.proxyUrl,
    ALL_PROXY: input.proxyUrl,
    all_proxy: input.proxyUrl,
    GRPC_PROXY: input.proxyUrl,
    grpc_proxy: input.proxyUrl,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: input.noProxy?.NO_PROXY,
    no_proxy: input.noProxy?.no_proxy,
  };
  if (input.caBundlePath?.trim()) {
    env.NODE_EXTRA_CA_CERTS = input.caBundlePath.trim();
    applyNeutralCaTrustAliases(env);
    delete env.NODE_EXTRA_CA_CERTS;
  }
  applyAgentEgressNoProxyEnv(env, { externalBypass: false });
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}
