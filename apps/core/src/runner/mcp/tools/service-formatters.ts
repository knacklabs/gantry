import { SAME_SESSION_SKILL_CONTEXT_MAX_BYTES } from './service-constants.js';

export function formatMcpApprovalResponse(
  data: unknown,
  message: string,
): string {
  const context = parseApprovedMcpContext(data);
  if (!context) return message;
  return [
    message,
    '',
    'How to use it now:',
    `- List approved tools: call mcp_list_tools with serverName="${context.server.name}"`,
    `- Call an approved tool: call mcp_call_tool with serverName="${context.server.name}", toolName="<tool>", arguments={...}`,
    context.approvedToolNames.length > 0
      ? `- Approved tool names: ${context.approvedToolNames.join(', ')}`
      : '- No explicit tool names were provided; use mcp_list_tools to inspect approved tools.',
  ].join('\n');
}

export function formatMcpListToolsResponse(data: unknown): string {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'No approved MCP tools were returned.';
  }
  const servers = Array.isArray((data as Record<string, unknown>).servers)
    ? ((data as Record<string, unknown>).servers as unknown[])
    : [];
  if (servers.length === 0) return 'No approved MCP tools are available.';
  const lines = ['Approved MCP tools:'];
  for (const server of servers) {
    if (!server || typeof server !== 'object' || Array.isArray(server)) {
      continue;
    }
    const record = server as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : 'unknown';
    const tools = Array.isArray(record.tools) ? record.tools : [];
    lines.push(`\n## ${name}`);
    if (tools.length === 0) {
      lines.push('- No approved tools exposed by this server.');
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

function parseApprovedMcpContext(data: unknown): {
  server: { id: string; name: string };
  approvedToolNames: string[];
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'approved_mcp_context') return null;
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
    approvedToolNames: Array.isArray(record.approvedToolNames)
      ? record.approvedToolNames.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  };
}

export function formatSkillProposalResponse(
  data: unknown,
  message: string,
): string {
  const context = parseApprovedSkillContext(data);
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
    context.skill.contentHash
      ? `- Package hash: ${context.skill.contentHash}`
      : undefined,
    context.requiredEnvVars.length > 0
      ? `- Required Gantry Secrets: ${context.requiredEnvVars.join(', ')}`
      : undefined,
    '',
    'Use this skill now by following its SKILL.md. Gantry will load it automatically for later runs.',
    '',
    'Approved skill files:',
  ].filter((line): line is string => line !== undefined);

  let remainingBytes = SAME_SESSION_SKILL_CONTEXT_MAX_BYTES;
  for (const file of context.files) {
    const contentBytes = Buffer.byteLength(file.content, 'utf-8');
    lines.push('');
    lines.push(`## ${file.path}`);
    if (file.contentHash || typeof file.sizeBytes === 'number') {
      lines.push(
        [
          file.contentHash ? `hash=${file.contentHash}` : undefined,
          typeof file.sizeBytes === 'number'
            ? `size=${file.sizeBytes} bytes`
            : undefined,
        ]
          .filter(Boolean)
          .join(', '),
      );
    }
    if (remainingBytes <= 0) {
      lines.push(
        '[Content omitted because the approved skill bundle is large.]',
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

function parseApprovedSkillContext(data: unknown): {
  skill: {
    id: string;
    name: string;
    description?: string;
    contentHash?: string;
  };
  requiredEnvVars: string[];
  files: Array<{
    path: string;
    content: string;
    contentHash?: string;
    sizeBytes?: number;
  }>;
} | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== 'approved_skill_context') return null;
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
            ...(typeof item.contentHash === 'string'
              ? { contentHash: item.contentHash }
              : {}),
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
      ...(typeof skill.contentHash === 'string'
        ? { contentHash: skill.contentHash }
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
