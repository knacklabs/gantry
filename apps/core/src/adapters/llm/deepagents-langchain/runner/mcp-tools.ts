import fs from 'node:fs';

import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';

import { buildGantryMcpProjection } from './gantry-mcp-env.js';
import {
  wrapThirdPartyMcpToolsWithGate,
  type ThirdPartyMcpGateConfig,
} from './third-party-mcp-gate.js';
import { createGantryShellTool } from './gantry-shell-tool.js';
import { isHostPrivateBrowserMcpServerName } from '../../../../shared/agent-tool-references.js';
import { isRunCommandToolRule } from '../../../../shared/gantry-tool-facades.js';

// Connects the DeepAgents runner to Gantry-owned MCP authority and converts it
// to LangChain tools. DeepAgents has no autonomous MCP — we fully control the
// `tools` list — so this module is the only place MCP tools enter the graph.
//
//   - The Gantry facade server (apps/core/src/runner/mcp/stdio.js) is spawned
//     here as a stdio MCP server with the projected GANTRY_* env block; its
//     tools are filtered to the host-selected name set (browser_* only when the
//     host enabled browser IPC).
//   - Selected third-party MCP servers (GANTRY_MCP_CONFIG_FILE) are connected as
//     additional stdio/http servers and each tool is wrapped with the neutral
//     permission gate before it can execute.
//
// We set prefixToolNameWithServerName=false and additionalToolNamePrefix='' so a
// LangChain tool's `.name` equals the raw MCP tool name (send_message,
// browser_open, ...), which is what the host selection set and tool-policy rules
// reference. throwOnLoadError=true fails the run loudly if a required server
// cannot connect rather than silently dropping authority.

const GANTRY_SERVER_NAME = 'gantry';

interface StdioServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface RemoteServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

type ExternalServerConfig = Partial<StdioServerConfig> &
  Partial<RemoteServerConfig>;

export interface ConnectedMcpTools {
  tools: StructuredToolInterface[];
  close: () => Promise<void>;
}

export interface ConnectGantryMcpInput {
  configuredAllowedTools: readonly string[];
  hideAuthorityTools: boolean;
  gate: Omit<ThirdPartyMcpGateConfig, 'configuredAllowedTools'>;
  // Run-cancellation signal threaded into the gated shell tool so a command in
  // flight is killed when the live-turn close sentinel aborts the run.
  shellSignal?: AbortSignal;
  // Working directory for the gated shell tool (defaults to the runner cwd, the
  // sandboxed group workspace root).
  shellCwd?: string;
}

export async function connectGantryAndThirdPartyMcpTools(
  input: ConnectGantryMcpInput,
): Promise<ConnectedMcpTools> {
  const mcpServerPath = process.env.GANTRY_MCP_SERVER_PATH?.trim();
  if (!mcpServerPath) {
    throw new Error(
      'DeepAgents runner is missing GANTRY_MCP_SERVER_PATH for the Gantry facade MCP server.',
    );
  }

  const projection = buildGantryMcpProjection({
    configuredAllowedTools: input.configuredAllowedTools,
    hideAuthorityTools: input.hideAuthorityTools,
    processEnv: process.env,
  });

  const externalServers = readExternalMcpServers();

  const mcpServers: Record<string, unknown> = {
    [GANTRY_SERVER_NAME]: {
      transport: 'stdio',
      command: 'node',
      args: [mcpServerPath],
      env: projection.env,
      stderr: 'inherit',
    },
  };
  for (const [name, config] of Object.entries(externalServers)) {
    mcpServers[name] = toMultiServerConnection(config);
  }

  const client = new MultiServerMCPClient({
    mcpServers: mcpServers as never,
    throwOnLoadError: true,
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: '',
    useStandardContentBlocks: true,
  });

  let serverTools: Record<string, StructuredToolInterface[]>;
  try {
    serverTools = (await client.initializeConnections()) as unknown as Record<
      string,
      StructuredToolInterface[]
    >;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }

  const selectedGantrySet = new Set(projection.selectedToolNames);
  const gantryTools = (serverTools[GANTRY_SERVER_NAME] ?? []).filter((tool) =>
    selectedGantrySet.has(tool.name),
  );

  const thirdPartyTools: StructuredToolInterface[] = [];
  for (const [name, tools] of Object.entries(serverTools)) {
    if (name === GANTRY_SERVER_NAME) continue;
    thirdPartyTools.push(...tools);
  }
  const gatedThirdPartyTools = wrapThirdPartyMcpToolsWithGate(thirdPartyTools, {
    ...input.gate,
    configuredAllowedTools: input.configuredAllowedTools,
  });

  const shellTools = projectGantryShellTool(input);

  return {
    tools: [...gantryTools, ...gatedThirdPartyTools, ...shellTools],
    close: () => client.close(),
  };
}

// Whether the Gantry-owned, policy-gated shell tool should be injected into the
// graph for this run. Both conditions must hold:
//   (a) the host enabled it via GANTRY_DEEPAGENTS_SHELL_ENABLED='1' — derived on
//       the host from the SAME guard inputs (engine deepagents + RunCommand rule
//       + enforcing sandbox_runtime); the host fails the spawn closed otherwise, AND
//   (b) a resolved tool rule actually grants RunCommand/shell authority.
// A missing/absent host flag OR no RunCommand rule means no shell tool — behavior
// is exactly as before, and the model has no execution surface at all (StateBackend
// + DENY_ALL_FILESYSTEM leave deepagents with no `execute`). Exported for unit
// coverage of the two-condition gate.
export function shouldProjectGantryShellTool(input: {
  shellEnabledEnv: string | undefined;
  configuredAllowedTools: readonly string[];
}): boolean {
  if (input.shellEnabledEnv !== '1') return false;
  return input.configuredAllowedTools.some((rule) =>
    isRunCommandToolRule(rule),
  );
}

function projectGantryShellTool(
  input: ConnectGantryMcpInput,
): StructuredToolInterface[] {
  if (
    !shouldProjectGantryShellTool({
      shellEnabledEnv: process.env.GANTRY_DEEPAGENTS_SHELL_ENABLED,
      configuredAllowedTools: input.configuredAllowedTools,
    })
  ) {
    return [];
  }
  return [
    createGantryShellTool({
      workspaceFolder: input.gate.workspaceFolder,
      memoryBlock: input.gate.memoryBlock,
      configuredAllowedTools: input.configuredAllowedTools,
      gateContext: input.gate.gateContext,
      permissionEnv: input.gate.permissionEnv,
      lockedAccessPreset: input.gate.lockedAccessPreset,
      ...(input.shellCwd ? { cwd: input.shellCwd } : {}),
      ...(input.shellSignal ? { signal: input.shellSignal } : {}),
    }),
  ];
}

function readExternalMcpServers(): Record<string, ExternalServerConfig> {
  const configPath = process.env.GANTRY_MCP_CONFIG_FILE?.trim();
  if (!configPath) return {};
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, ExternalServerConfig>;
  const servers: Record<string, ExternalServerConfig> = {};
  for (const [name, config] of Object.entries(parsed)) {
    if (name === GANTRY_SERVER_NAME) {
      throw new Error(
        'Configured MCP servers cannot override the built-in gantry server',
      );
    }
    if (isHostPrivateBrowserMcpServerName(name)) {
      throw new Error(
        'Host-private browser MCP servers are not configurable. Use the canonical Browser capability and Gantry-owned browser gateway tools.',
      );
    }
    servers[name] = config;
  }
  return servers;
}

function toMultiServerConnection(config: ExternalServerConfig): unknown {
  if (config.type === 'http' || config.type === 'sse') {
    if (!config.url) {
      throw new Error('Configured remote MCP server is missing a url.');
    }
    return {
      transport: config.type === 'sse' ? 'sse' : 'http',
      url: config.url,
      ...(config.headers ? { headers: config.headers } : {}),
    };
  }
  if (!config.command) {
    throw new Error('Configured stdio MCP server is missing a command.');
  }
  return {
    transport: 'stdio',
    command: config.command,
    args: config.args ?? [],
    ...(config.env ? { env: config.env } : {}),
    stderr: 'inherit',
  };
}
