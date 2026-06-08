import fs from 'node:fs';

import type { McpServerConfig } from '../agent-capabilities.js';
import { isHostPrivateBrowserMcpServerName } from '../../../../shared/agent-tool-references.js';

export function readExternalMcpServers(): Record<string, McpServerConfig> {
  const configPath = process.env.GANTRY_MCP_CONFIG_FILE?.trim();
  if (configPath) {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<
      string,
      McpServerConfig
    >;
    fs.rmSync(configPath, { force: true });
    return validateExternalMcpServers(parsed);
  }
  const raw = process.env.GANTRY_MCP_SERVERS_JSON?.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Record<string, McpServerConfig>;
  return validateExternalMcpServers(parsed);
}

export type McpServerStatusSample = {
  name?: unknown;
  status?: unknown;
  error?: unknown;
};

export type EnsureRequiredMcpServerReadyDeps = {
  /**
   * Polls the SDK for the live MCP server statuses (query.mcpServerStatus()).
   * Omitted when the query handle cannot report live status — in that case a
   * `pending` snapshot becomes a hard failure, preserving the original
   * fail-closed behavior.
   */
  getLiveStatuses?: () => Promise<McpServerStatusSample[]>;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
};

function readInitMcpServers(message: unknown): McpServerStatusSample[] {
  const initMessage = message as { mcp_servers?: McpServerStatusSample[] };
  if (!Array.isArray(initMessage.mcp_servers)) {
    throw new Error(
      'Required Gantry MCP server status is missing from Claude init',
    );
  }
  return initMessage.mcp_servers;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms the built-in `gantry` MCP server is connected before the agent runs.
 *
 * Claude Agent SDK >= 0.3.156 emits the `system/init` message BEFORE stdio MCP
 * servers finish their async connect, so the init snapshot can report the
 * `gantry` server as `pending` even though it connects healthily a moment
 * later. Throwing on that first snapshot breaks every agent reply with
 * "Required Gantry MCP server is not ready: pending". Instead we treat `pending`
 * as transient and poll the SDK's live `mcpServerStatus()` until the server
 * reaches `connected` (or a terminal failure / timeout), which is the
 * SDK-blessed way to read live connection state.
 */
export async function ensureRequiredMcpServerReady(
  initMessage: unknown,
  deps: EnsureRequiredMcpServerReadyDeps = {},
): Promise<void> {
  const {
    getLiveStatuses,
    sleep = defaultSleep,
    pollIntervalMs = 150,
    maxPollAttempts = 100,
  } = deps;

  let servers = readInitMcpServers(initMessage);
  for (let attempt = 0; ; attempt++) {
    const gantryServer = servers.find((server) => server?.name === 'gantry');
    if (!gantryServer) {
      throw new Error('Required Gantry MCP server is missing from Claude init');
    }
    const status = String(gantryServer.status ?? '').toLowerCase();
    if (status === 'connected') return;
    if (status !== 'pending') {
      // Terminal status (failed / needs-auth / disabled / unknown): surface it
      // immediately with any error detail the SDK provided.
      const detail =
        typeof gantryServer.error === 'string' && gantryServer.error
          ? ` (${gantryServer.error})`
          : '';
      throw new Error(
        `Required Gantry MCP server is not ready: ${status}${detail}`,
      );
    }
    // `pending`: the SDK connects stdio MCP servers asynchronously after init.
    // Poll the live status until it connects, then bail out if it never does.
    if (!getLiveStatuses || attempt >= maxPollAttempts) {
      throw new Error(`Required Gantry MCP server is not ready: ${status}`);
    }
    await sleep(pollIntervalMs);
    servers = await getLiveStatuses();
  }
}

function validateExternalMcpServers(
  parsed: Record<string, McpServerConfig>,
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
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
    servers[name] = config;
  }
  return servers;
}

const isHostPrivateBrowserServerName = isHostPrivateBrowserMcpServerName;
