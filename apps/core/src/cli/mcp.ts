import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';

type ConnectOptions = {
  name?: string;
  transport?: 'stdio_template';
  templateId?: string;
  args: string[];
  sandboxProfileId?: string;
  agentId?: string;
  allowedToolPatterns: string[];
  autoApproveToolPatterns: string[];
  credentialRefs: Array<{
    name: string;
    target: 'env' | 'header';
    key: string;
  }>;
  createdBy?: string;
  requestedReason?: string;
  riskClass?: 'low' | 'medium' | 'high';
  required?: boolean;
  permissionPolicyIds: string[];
};

function usage(): string {
  return [
    'Usage:',
    '  gantry mcp connect --name <name> --transport <stdio_template> --template <node-script|npx-package> --sandbox-profile <id> --agent <agentId> [--arg <value>] [--tool <name>] [--credential <name:env:key>]',
    '  gantry mcp list [--status <active|disabled>]',
    '  gantry mcp show <serverId>',
    '  gantry mcp doctor <serverId> [--by <admin>]',
    '  gantry mcp remove <serverId> --agent <agentId>',
    '  gantry mcp disable <serverId> [--reason <text>] [--by <admin>]',
  ].join('\n');
}

export async function runMcpCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, first, ...rest] = args;
  try {
    if (command === 'connect')
      return await connectServer(runtimeHome, args.slice(1));
    if (command === 'list')
      return await listServers(runtimeHome, args.slice(1));
    if (command === 'show') return await showServer(runtimeHome, first);
    if (command === 'doctor')
      return await doctorServer(runtimeHome, first, rest);
    if (command === 'remove')
      return await removeServer(runtimeHome, first, rest);
    if (command === 'disable') {
      return await disableServer(runtimeHome, first, rest);
    }
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : 'MCP command failed');
    return 1;
  }
  p.note(usage(), 'MCP Servers');
  return 1;
}

async function connectServer(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const parsed = parseConnectArgs(args);
  if ('error' in parsed) {
    p.log.error(parsed.error);
    return 1;
  }
  const created = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: '/v1/mcp-servers',
    body: {
      name: parsed.name,
      transport: parsed.transport,
      config: transportConfig(parsed),
      allowedToolPatterns: parsed.allowedToolPatterns,
      autoApproveToolPatterns: parsed.autoApproveToolPatterns,
      credentialRefs: parsed.credentialRefs,
      sandboxProfileId: parsed.sandboxProfileId,
      createdBy: parsed.createdBy,
      requestedReason: parsed.requestedReason,
      riskClass: parsed.riskClass,
    },
  });
  const server =
    isRecord(created) && isRecord(created.server) ? created.server : null;
  const serverId = String(server?.id ?? '');
  if (!serverId) throw new Error('MCP connect returned an invalid response.');
  await controlApiRequest(runtimeHome, {
    method: 'PUT',
    path: `/v1/agents/${encodeURIComponent(normalizeAgentId(parsed.agentId!))}/mcp-servers/${encodeURIComponent(serverId)}`,
    body: {
      required: parsed.required,
      permissionPolicyIds: parsed.permissionPolicyIds,
    },
  });
  p.note(
    [`server: ${serverId}`, `agent: ${normalizeAgentId(parsed.agentId!)}`].join(
      '\n',
    ),
    'MCP Connected',
  );
  return 0;
}

function parseConnectArgs(args: string[]): ConnectOptions | { error: string } {
  const options: ConnectOptions = {
    args: [],
    allowedToolPatterns: [],
    autoApproveToolPatterns: [],
    credentialRefs: [],
    permissionPolicyIds: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const value = args[index + 1] || '';
    if (arg === '--name') {
      options.name = value;
      index += 1;
    } else if (arg === '--transport') {
      if (value !== 'stdio_template') {
        return { error: 'Invalid --transport. Use stdio_template.' };
      }
      options.transport = value;
      index += 1;
    } else if (arg === '--template') {
      options.templateId = value;
      index += 1;
    } else if (arg === '--arg') {
      options.args.push(value);
      index += 1;
    } else if (arg === '--sandbox-profile') {
      options.sandboxProfileId = value;
      index += 1;
    } else if (arg === '--agent') {
      options.agentId = value;
      index += 1;
    } else if (arg === '--tool') {
      options.allowedToolPatterns.push(value);
      index += 1;
    } else if (arg === '--auto-tool') {
      options.autoApproveToolPatterns.push(value);
      index += 1;
    } else if (arg === '--credential') {
      const ref = parseCredentialRef(value);
      if (!ref) return { error: 'Use --credential <name:env|header:key>.' };
      options.credentialRefs.push(ref);
      index += 1;
    } else if (arg === '--policy') {
      options.permissionPolicyIds.push(value);
      index += 1;
    } else if (arg === '--required') {
      options.required = true;
    } else if (arg === '--by' || arg === '--created-by') {
      options.createdBy = value;
      index += 1;
    } else if (arg === '--reason') {
      options.requestedReason = value;
      index += 1;
    } else if (arg === '--risk') {
      if (value !== 'low' && value !== 'medium' && value !== 'high') {
        return { error: 'Invalid --risk. Use low, medium, or high.' };
      }
      options.riskClass = value;
      index += 1;
    } else {
      return { error: `Unknown MCP connect option: ${arg}` };
    }
  }
  if (!options.name) return { error: 'Missing --name.' };
  if (!options.transport) return { error: 'Missing --transport.' };
  if (!options.templateId) return { error: 'Missing --template.' };
  if (!options.sandboxProfileId) return { error: 'Missing --sandbox-profile.' };
  if (!options.agentId) return { error: 'Missing --agent.' };
  return options;
}

function transportConfig(input: ConnectOptions): Record<string, unknown> {
  return {
    transport: 'stdio_template',
    templateId: input.templateId,
    ...(input.args.length > 0 ? { args: input.args } : {}),
  };
}

async function listServers(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const status = flagValue(args, '--status');
  const response = await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/mcp-servers${status ? `?status=${encodeURIComponent(status)}` : ''}`,
  });
  printList(response, 'servers', 'MCP Servers');
  return 0;
}

async function showServer(runtimeHome: string, serverId = ''): Promise<number> {
  if (!serverId) {
    p.log.error('Missing server id for mcp show.');
    return 1;
  }
  const response = await controlApiRequest(runtimeHome, {
    method: 'GET',
    path: `/v1/mcp-servers/${encodeURIComponent(serverId)}`,
  });
  printRecord(response, 'MCP Server');
  return 0;
}

async function doctorServer(
  runtimeHome: string,
  serverId = '',
  args: string[],
): Promise<number> {
  if (!serverId) {
    p.log.error('Missing server id for mcp doctor.');
    return 1;
  }
  const by = flagValue(args, '--by');
  const response = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/mcp-servers/${encodeURIComponent(serverId)}/test`,
    body: { testedBy: by },
  });
  printRecord(response, 'MCP Doctor');
  return 0;
}

async function removeServer(
  runtimeHome: string,
  serverId = '',
  args: string[],
): Promise<number> {
  if (!serverId) {
    p.log.error('Missing server id for mcp remove.');
    return 1;
  }
  const agentId = flagValue(args, '--agent');
  if (!agentId) {
    p.log.error('Missing --agent for mcp remove.');
    return 1;
  }
  const response = await controlApiRequest(runtimeHome, {
    method: 'DELETE',
    path: `/v1/agents/${encodeURIComponent(normalizeAgentId(agentId))}/mcp-servers/${encodeURIComponent(serverId)}`,
  });
  printRecord(response, 'MCP Removed');
  return 0;
}

async function disableServer(
  runtimeHome: string,
  serverId = '',
  args: string[],
): Promise<number> {
  if (!serverId) {
    p.log.error('Missing server id for mcp disable.');
    return 1;
  }
  const response = await controlApiRequest(runtimeHome, {
    method: 'POST',
    path: `/v1/mcp-servers/${encodeURIComponent(serverId)}/disable`,
    body: {
      disabledBy: flagValue(args, '--by'),
      reason: flagValue(args, '--reason'),
    },
  });
  printRecord(response, 'MCP Disabled');
  return 0;
}

function parseCredentialRef(
  value: string,
): ConnectOptions['credentialRefs'][number] | null {
  const [name, target, key] = value.split(':');
  if (!name || !key || (target !== 'env' && target !== 'header')) return null;
  return { name, target, key };
}

function flagValue(args: string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) return args[index + 1] || undefined;
    if (arg?.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function normalizeAgentId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

function printList(response: unknown, key: string, title: string): void {
  const items = Array.isArray(isRecord(response) ? response[key] : undefined)
    ? (response as Record<string, unknown[]>)[key]
    : [];
  p.note(items.map(formatRecord).join('\n') || 'No records found.', title);
}

function printRecord(response: unknown, title: string): void {
  p.note(JSON.stringify(response, null, 2), title);
}

function formatRecord(input: unknown): string {
  if (!isRecord(input)) return '- <invalid>';
  return `- ${String(input.name ?? input.id ?? '<unknown>')} (${String(input.id ?? '')}) [${String(input.status ?? '')}]`;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === 'object';
}
