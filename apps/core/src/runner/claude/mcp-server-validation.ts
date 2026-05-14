import fs from 'node:fs';

import type { McpServerConfig } from '../agent-capabilities.js';
import { isHostPrivateBrowserMcpServerName } from '../../shared/agent-tool-references.js';

export function readExternalMcpServers(): Record<string, McpServerConfig> {
  const configPath = process.env.MYCLAW_MCP_CONFIG_FILE?.trim();
  if (configPath) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      McpServerConfig
    >;
    fs.rmSync(configPath, { force: true });
    return validateExternalMcpServers(parsed);
  }
  const raw = process.env.MYCLAW_MCP_SERVERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, McpServerConfig>;
  return validateExternalMcpServers(parsed);
}

export function assertRequiredMcpServerReady(message: unknown): void {
  const initMessage = message as {
    mcp_servers?: Array<{ name?: unknown; status?: unknown }>;
  };
  if (!Array.isArray(initMessage.mcp_servers)) {
    throw new Error(
      'Required MyClaw MCP server status is missing from Claude init',
    );
  }

  const myclawServer = initMessage.mcp_servers.find(
    (server) => server.name === 'myclaw',
  );
  if (!myclawServer) {
    throw new Error('Required MyClaw MCP server is missing from Claude init');
  }

  const status = String(myclawServer.status ?? '').toLowerCase();
  if (status !== 'connected') {
    throw new Error(`Required MyClaw MCP server is not ready: ${status}`);
  }
}

function validateExternalMcpServers(
  parsed: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(parsed)) {
    if (name === 'myclaw') {
      throw new Error(
        'Configured MCP servers cannot override the built-in myclaw server',
      );
    }
    if (isHostPrivateBrowserServerName(name)) {
      throw new Error(
        'Host-private browser MCP servers are not configurable. Use the canonical Browser capability and MyClaw-owned browser gateway tools.',
      );
    }
    servers[name] = config;
  }
  return servers;
}

const isHostPrivateBrowserServerName = isHostPrivateBrowserMcpServerName;
