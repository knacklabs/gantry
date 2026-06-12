import { SAME_SESSION_SKILL_CONTEXT_MAX_BYTES } from './service-constants.js';
import {
  SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
  UNREVIEWED_DISCOVERY_GUIDANCE,
} from '../../../shared/capability-guidance.js';

export function formatMcpApprovalResponse(
  data: unknown,
  message: string,
): string {
  const context = parseConnectedMcpContext(data);
  if (!context) return message;
  return [
    message,
    '',
    'Source status:',
    '- Connected Sources: MCP server source recorded.',
    '- Allowed Capabilities: unchanged until a reviewed capability is granted.',
    '- Needs Review: raw MCP actions discovered from this source.',
    '',
    'Next action:',
    `- Refresh source inventory: call mcp_list_tools with serverName="${context.server.name}"`,
    '- Request durable access: use request_access with target.kind=capability when a reviewed capability exists.',
    '- Immediate command fallback: use request_access with target.kind=run_command and temporaryOnly=true if no reviewed capability fits.',
    context.availableToolNames.length > 0
      ? `- Source-reported tool names: ${context.availableToolNames.join(', ')}`
      : '- No explicit tool names were provided; use mcp_list_tools to inspect available tools.',
    SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
  ].join('\n');
}

export function formatMcpListToolsResponse(
  data: unknown,
  options: { includeReviewGuidance?: boolean } = {},
): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'No MCP tools were returned.';
  }
  const servers = Array.isArray((data as Record<string, unknown>).servers)
    ? ((data as Record<string, unknown>).servers as unknown[])
    : [];
  if (servers.length === 0) return 'No MCP tools are available.';
  // Locked agents get the provisioned tool listing without review/authority
  // machinery guidance.
  const lines =
    options.includeReviewGuidance === false
      ? ['Tools available from connected MCP servers:']
      : [
          'MCP source inventory:',
          SOURCE_INVENTORY_AUTHORITY_GUIDANCE,
          UNREVIEWED_DISCOVERY_GUIDANCE,
        ];
  for (const server of servers) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      continue;
    }
    const record = server as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : 'unknown';
    const tools = Array.isArray(record.tools) ? record.tools : [];
    lines.push(`\n## ${name}`);
    if (tools.length === 0) {
      lines.push('- No tools exposed by this server.');
      continue;
    }
    for (const tool of tools) {
      if (!tool || typeof tool !== 'object' || Array.isArray(tool)) continue;
      const item = tool as Record<string, unknown>;
      const toolName =
        typeof item.name === 'string' ? item.name : 'unnamed_tool';
      const description =
        typeof item.description === 'string' ? ` - ${item.description}` : '';
      lines.push(`- ${toolName}${description}`);
    }
  }
  return lines.join('\n');
}

export function formatMcpCallToolResponse(data: unknown): string {
  if (typeof data === 'string') return data;
  return JSON.stringify(data ?? null, null, 2);
}

function parseConnectedMcpContext(data: unknown): {
  server: { id: string; name: string };
  availableToolNames: string[];
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'connected_mcp_context') return null;
  const server =
    record.server &&
    typeof record.server === 'object' &&
    !Array.isArray(record.server)
      ? (record.server as Record<string, unknown>)
      : null;
  if (
    !server ||
    typeof server.id !== 'string' ||
    typeof server.name !== 'string'
  ) {
    return null;
  }
  return {
    server: { id: server.id, name: server.name },
    availableToolNames: Array.isArray(record.availableToolNames)
      ? record.availableToolNames.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

export function formatSkillProposalResponse(
  data: unknown,
  message: string,
  options: { deploymentMode?: 'workstation' | 'fleet' } = {},
): string {
  const context = parseInstalledSkillContext(data);
  if (!context) return message;
  const lines = [
    message,
    '',
    'Skill context:',
    `- Skill: ${context.skill.name}`,
    `- Skill ID: ${context.skill.id}`,
    context.skill.description
      ? `- Description: ${context.skill.description}`
      : undefined,
    context.requiredEnvVars.length > 0
      ? `- Required Gantry Credentials: ${context.requiredEnvVars.join(', ')}`
      : undefined,
    '',
    'Source status:',
    '- Connected Sources: skill source installed.',
    '- Allowed Capabilities: unchanged until a reviewed capability is granted.',
    '- Needs Review: any gantry.skill.json actions that are not reviewed yet.',
    '',
    // In fleet mode the install is not local: the skill activates on a worker
    // only after it propagates to eligible workers.
    options.deploymentMode === 'fleet'
      ? 'Use this skill now by following its SKILL.md. Risky actions still require a reviewed capability grant. Gantry will load the skill automatically for later runs after it propagates to eligible workers.'
      : 'Use this skill now by following its SKILL.md. Risky actions still require a reviewed capability grant. Gantry will load the skill automatically for later runs.',
    '',
    'Installed skill files:',
  ].filter((line): line is string => line !== undefined);

  let remainingBytes = SAME_SESSION_SKILL_CONTEXT_MAX_BYTES;
  for (const file of context.files) {
    const contentBytes = Buffer.byteLength(file.content, 'utf-8');
    lines.push('');
    lines.push(`## ${file.path}`);
    if (typeof file.sizeBytes === 'number') {
      lines.push(`size=${file.sizeBytes} bytes`);
    }
    if (remainingBytes <= 0) {
      lines.push(
        '[Content omitted because the installed skill bundle is large.]',
      );
      continue;
    }
    const visibleContent =
      contentBytes <= remainingBytes
        ? file.content
        : file.content.slice(0, remainingBytes);
    remainingBytes -= Buffer.byteLength(visibleContent, 'utf-8');
    lines.push('```');
    lines.push(visibleContent);
    lines.push('```');
    if (contentBytes > Buffer.byteLength(visibleContent, 'utf-8')) {
      lines.push('[Content truncated for immediate skill context.]');
    }
  }
  return lines.join('\n');
}

function parseInstalledSkillContext(data: unknown): {
  skill: {
    id: string;
    name: string;
    description?: string;
  };
  requiredEnvVars: string[];
  files: Array<{
    path: string;
    content: string;
    sizeBytes?: number;
  }>;
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'installed_skill_context') return null;
  const skill =
    record.skill &&
    typeof record.skill === 'object' &&
    !Array.isArray(record.skill)
      ? (record.skill as Record<string, unknown>)
      : null;
  if (
    !skill ||
    typeof skill.id !== 'string' ||
    typeof skill.name !== 'string'
  ) {
    return null;
  }
  const files = Array.isArray(record.files)
    ? record.files
        .map((file) => {
          if (!file || typeof file !== 'object' || Array.isArray(file)) {
            return null;
          }
          const item = file as Record<string, unknown>;
          if (
            typeof item.path !== 'string' ||
            typeof item.content !== 'string'
          ) {
            return null;
          }
          return {
            path: item.path,
            content: item.content,
            ...(typeof item.sizeBytes === 'number'
              ? { sizeBytes: item.sizeBytes }
              : {}),
          };
        })
        .filter((file): file is NonNullable<typeof file> => file !== null)
    : [];
  if (files.length === 0) return null;
  return {
    skill: {
      id: skill.id,
      name: skill.name,
      ...(typeof skill.description === 'string'
        ? { description: skill.description }
        : {}),
    },
    requiredEnvVars: Array.isArray(record.requiredEnvVars)
      ? record.requiredEnvVars.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
    files,
  };
}
