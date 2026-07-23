import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { ApplicationError } from '../common/application-error.js';
import type { MaterializedMcpCapability } from './mcp-server-service.js';
import {
  RemoteMcpDnsValidationCache,
  assertRemoteMcpDestinationPublic,
} from './mcp-server-policy.js';
import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
  isLocalLoopbackHttpMcpUrl,
} from './mcp-tool-proxy-network.js';
import {
  cacheMcpClient,
  readCachedMcpClient,
} from './mcp-tool-proxy-client-cache.js';
import { invalidateMcpToolProxyInventoryCacheForCapability } from './mcp-tool-inventory.js';

const MCP_PROXY_TIMEOUT_MS = 60_000;

type ConnectableMcpClient<TTransport> = {
  connect(
    transport: TTransport,
    options: { timeout: number },
  ): Promise<unknown>;
  close(): Promise<unknown> | unknown;
};

export type McpToolProxyClientAdapters<
  TTransport,
  TClient extends ConnectableMcpClient<TTransport>,
> = {
  createClient(onToolsChanged: () => void): TClient;
  createHttpTransport(
    url: URL,
    options: {
      requestInit: RequestInit;
      fetch: typeof globalThis.fetch;
    },
  ): TTransport;
  createSseTransport(
    url: URL,
    options: {
      requestInit: RequestInit;
      fetch: typeof globalThis.fetch;
    },
  ): TTransport;
};

type McpClientTransport = Parameters<Client['connect']>[0];

export const MCP_TOOL_PROXY_CLIENT_ADAPTERS: McpToolProxyClientAdapters<
  McpClientTransport,
  Client
> = {
  createClient: (onToolsChanged) =>
    new Client(
      { name: 'gantry-mcp-proxy', version: '1.0.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 250,
            onChanged: onToolsChanged,
          },
        },
      },
    ),
  createHttpTransport: (url, options) =>
    new StreamableHTTPClientTransport(url, options),
  createSseTransport: (url, options) => new SSEClientTransport(url, options),
};

export async function connectMcpToolProxyClient<
  TTransport,
  TClient extends ConnectableMcpClient<TTransport>,
>(
  capability: MaterializedMcpCapability,
  options: {
    lookupHostname?: HostnameLookup;
    dnsValidationCache?: RemoteMcpDnsValidationCache;
    egressDenylist?: readonly string[];
  },
  adapters: McpToolProxyClientAdapters<TTransport, TClient>,
): Promise<TClient> {
  assertNetworkAllowedForCapability(capability, options.egressDenylist);
  const cached = readCachedMcpClient(capability) as TClient | null;
  if (cached) return cached;
  const client = adapters.createClient(() =>
    invalidateMcpToolProxyInventoryCacheForCapability(capability),
  );
  const transport = await createTransport(capability, options, adapters);
  await client.connect(transport, { timeout: MCP_PROXY_TIMEOUT_MS });
  const existing = readCachedMcpClient(capability) as TClient | null;
  if (existing) {
    await client.close();
    return existing;
  }
  cacheMcpClient(capability, client);
  return client;
}

async function createTransport<
  TTransport,
  TClient extends ConnectableMcpClient<TTransport>,
>(
  capability: MaterializedMcpCapability,
  options: {
    lookupHostname?: HostnameLookup;
    dnsValidationCache?: RemoteMcpDnsValidationCache;
  },
  adapters: McpToolProxyClientAdapters<TTransport, TClient>,
): Promise<TTransport> {
  const config = capability.config;
  if (config.type === 'http' || config.type === 'sse') {
    if (!isLocalLoopbackHttpMcpUrl(new URL(config.url))) {
      await assertRemoteMcpDestinationPublic(
        { transport: config.type, url: config.url, headers: config.headers },
        options.lookupHostname,
        { cache: options.dnsValidationCache },
      );
    }
    const allowLoopbackHttp = isLocalLoopbackHttpMcpUrl(new URL(config.url));
    const fetch = createGuardedMcpFetch({
      allowLoopbackHttp,
      lookupHostname: options.lookupHostname,
    });
    const requestInit: RequestInit = {
      redirect: 'error',
      ...(config.headers ? { headers: config.headers } : {}),
    };
    return config.type === 'http'
      ? adapters.createHttpTransport(new URL(config.url), {
          requestInit,
          fetch,
        })
      : adapters.createSseTransport(new URL(config.url), {
          requestInit,
          fetch,
        });
  }
  throw new ApplicationError(
    'FORBIDDEN',
    'stdio_template MCP servers are approved durable capabilities, but current-session proxy execution is disabled until sandboxed stdio execution is implemented.',
  );
}

function assertNetworkAllowedForCapability(
  capability: MaterializedMcpCapability,
  egressDenylist: readonly string[] | undefined,
): void {
  const config = capability.config;
  if (config.type !== 'http' && config.type !== 'sse') return;
  assertMcpNetworkHostAllowed({
    serverName: capability.name,
    url: config.url,
    denylist: egressDenylist ?? [],
  });
}
