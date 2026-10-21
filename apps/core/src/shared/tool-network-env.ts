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

export function projectSandboxToolNetworkEnv(
  configured: Record<string, string> | undefined,
  runtime: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (runtime.GANTRY_SANDBOX_RUNTIME_PROXY !== '1') return { ...configured };
  const http = runtime.HTTP_PROXY || runtime.http_proxy;
  const https = runtime.HTTPS_PROXY || runtime.https_proxy || http;
  if (!http || !https) throw new Error('Sandbox-runtime tool proxy is missing');
  const socks = runtime.ALL_PROXY || runtime.all_proxy || http;
  const grpc = runtime.GRPC_PROXY || runtime.grpc_proxy || socks;
  return {
    ...configured,
    HTTP_PROXY: http,
    http_proxy: http,
    HTTPS_PROXY: https,
    https_proxy: https,
    ALL_PROXY: socks,
    all_proxy: socks,
    GRPC_PROXY: grpc,
    grpc_proxy: grpc,
    NODE_USE_ENV_PROXY: '1',
    GODEBUG: configured?.GODEBUG || 'netdns=go',
    NO_PROXY: '',
    no_proxy: '',
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
