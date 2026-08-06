import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { McpServerConfig } from '../agent-capabilities.js';
import { isHostPrivateBrowserMcpServerName } from '../../../../shared/agent-tool-references.js';
import {
  EXTERNAL_MCP_AUDIT_FILE_ENV,
  externalMcpAuditFilePath,
} from './external-mcp-audit-protocol.js';

let externalMcpServerEgressEnv: Record<string, string> = {};
const AUDITED_EXTERNAL_MCP_PROXY_PATH = fileURLToPath(
  new URL('./audited-external-mcp-proxy.js', import.meta.url),
);

const TERMINAL_MCP_SERVER_FAILURE_STATUSES = new Set([
  'failed',
  'needs-auth',
  'disabled',
]);

export function readExternalMcpServers(): Record<string, McpServerConfig> {
  const configPath = process.env.GANTRY_MCP_CONFIG_FILE?.trim();
  if (configPath) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      McpServerConfig
    >;
    fs.rmSync(configPath, { force: true });
    return validateExternalMcpServers(withExternalMcpServerEgressEnv(parsed));
  }
  const raw = process.env.GANTRY_MCP_SERVERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, McpServerConfig>;
  return validateExternalMcpServers(withExternalMcpServerEgressEnv(parsed));
}

export function setExternalMcpServerEgressEnv(
  toolNetworkEnv: Record<string, string>,
): void {
  externalMcpServerEgressEnv = Object.fromEntries(
    Object.entries(toolNetworkEnv).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  );
}

function withExternalMcpServerEgressEnv(
  parsed: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(parsed).map(([name, config]) => {
      if (config.type === 'http' || config.type === 'sse') {
        return [name, config];
      }
      const stdioConfig = config as Extract<
        McpServerConfig,
        { type?: 'stdio' }
      >;
      return [
        name,
        {
          ...stdioConfig,
          env: {
            ...(stdioConfig.env ?? {}),
            ...externalMcpServerEgressEnv,
          },
        },
      ];
    }),
  );
}

export function assertRequiredMcpServerReady(message: unknown): void {
  const initMessage = message as {
    mcp_servers?: Array<{ name?: unknown; status?: unknown }>;
  };
  if (!Array.isArray(initMessage.mcp_servers)) {
    throw new Error(
      'Required Gantry MCP server status is missing from Claude init',
    );
  }

  const gantryServer = initMessage.mcp_servers.find(
    (server) => server.name === 'gantry',
  );
  if (!gantryServer) {
    throw new Error('Required Gantry MCP server is missing from Claude init');
  }

  const status = String(gantryServer.status ?? '').toLowerCase();
  // Claude emits init once and may snapshot an alwaysLoad stdio server before
  // its handshake completes. The SDK's timeout gates turn-one availability, so
  // polling here would duplicate that wait; only known terminal states fail.
  if (TERMINAL_MCP_SERVER_FAILURE_STATUSES.has(status)) {
    throw new Error(`Required Gantry MCP server is not ready: ${status}`);
  }
  const failedExternalServer = initMessage.mcp_servers.find((server) => {
    if (server.name === 'gantry') return false;
    return TERMINAL_MCP_SERVER_FAILURE_STATUSES.has(
      String(server.status ?? '').toLowerCase(),
    );
  });
  if (failedExternalServer) {
    throw new Error(
      `Required MCP server "${String(failedExternalServer.name)}" is not ready: ${String(failedExternalServer.status).toLowerCase()}`,
    );
  }
}

function validateExternalMcpServers(
  parsed: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  const auditFilePath = externalMcpAuditFilePath();
  if (auditFilePath) {
    fs.mkdirSync(path.dirname(auditFilePath), { recursive: true });
    fs.rmSync(auditFilePath, { force: true });
  }
  for (const [name, config] of Object.entries(parsed)) {
    if (name === 'gantry') {
      throw new Error(
        'Configured MCP servers cannot override the built-in gantry server',
      );
    }
    if (isHostPrivateBrowserServerName(name)) {
      throw new Error(
        'Host-private browser MCP servers are not configurable. Use the canonical Browser capability and Gantry-owned browser gateway tools.',
      );
    }
    if (config.type === 'http' || config.type === 'sse') {
      servers[name] = config;
      continue;
    }
    const stdioConfig = config as Extract<
      McpServerConfig,
      { type?: 'stdio' }
    >;
    servers[name] = {
      ...stdioConfig,
      command: process.execPath,
      args: [
        AUDITED_EXTERNAL_MCP_PROXY_PATH,
        name,
        stdioConfig.command,
        ...(stdioConfig.args ?? []),
      ],
      env: {
        ...(stdioConfig.env ?? {}),
        ...(auditFilePath
          ? { [EXTERNAL_MCP_AUDIT_FILE_ENV]: auditFilePath }
          : {}),
      },
    };
  }
  return servers;
}

const isHostPrivateBrowserServerName = isHostPrivateBrowserMcpServerName;
