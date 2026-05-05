import path from 'path';
import {
  ADMIN_MCP_TOOL_NAMES,
  isAdminMcpToolName,
  type AdminMcpToolName,
} from '../../shared/admin-mcp-tools.js';

function requirePathEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const IPC_DIR = requirePathEnv('MYCLAW_IPC_DIR');
export const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
export const TASKS_DIR = path.join(IPC_DIR, 'tasks');
export const MEMORY_REQUESTS_DIR = path.join(IPC_DIR, 'memory-requests');
export const MEMORY_RESPONSES_DIR = path.join(IPC_DIR, 'memory-responses');
export const BROWSER_REQUESTS_DIR = path.join(IPC_DIR, 'browser-requests');
export const BROWSER_RESPONSES_DIR = path.join(IPC_DIR, 'browser-responses');
export const TASK_RESPONSES_DIR = path.join(IPC_DIR, 'task-responses');
export const IPC_AUTH_TOKEN = process.env.MYCLAW_IPC_AUTH_TOKEN || '';
export const BROWSER_IPC_AUTH_TOKEN =
  process.env.MYCLAW_BROWSER_IPC_AUTH_TOKEN || IPC_AUTH_TOKEN;
export const MEMORY_IPC_AUTH_TOKEN =
  process.env.MYCLAW_MEMORY_IPC_AUTH_TOKEN || IPC_AUTH_TOKEN;
export const IPC_RESPONSE_VERIFY_KEY =
  process.env.MYCLAW_IPC_RESPONSE_VERIFY_KEY || '';

export const chatJid = process.env.MYCLAW_CHAT_JID!;
export const groupFolder = process.env.MYCLAW_GROUP_FOLDER!;
export const threadId = process.env.MYCLAW_THREAD_ID?.trim() || undefined;
export const memoryUserId =
  process.env.MYCLAW_MEMORY_USER_ID?.trim() || undefined;
export const memoryDefaultScope =
  process.env.MYCLAW_MEMORY_DEFAULT_SCOPE === 'user' ? 'user' : 'group';
export const browserProfileName =
  process.env.MYCLAW_BROWSER_PROFILE_NAME?.trim() || undefined;
export const enabledAdminMcpTools = parseEnabledAdminMcpTools(
  process.env.MYCLAW_ADMIN_MCP_TOOLS_JSON,
);

export function isAdminMcpToolEnabled(toolName: AdminMcpToolName): boolean {
  return enabledAdminMcpTools.has(toolName);
}

function parseEnabledAdminMcpTools(
  raw: string | undefined,
): Set<AdminMcpToolName> {
  if (!raw?.trim()) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item): item is AdminMcpToolName => isAdminMcpToolName(item)),
    );
  } catch {
    return new Set();
  }
}

export function capabilityStatusText(): string {
  const lines = [
    'MyClaw admin tool capabilities:',
    ...ADMIN_MCP_TOOL_NAMES.map((toolName) => {
      const fullName = `mcp__myclaw__${toolName}`;
      if (enabledAdminMcpTools.has(toolName)) {
        return `- available: ${fullName}`;
      }
      return [
        `- requestable: ${fullName}`,
        `  tool_id: tool:${fullName}`,
        `  request_permission: permissionKind=tool toolName=${fullName} temporaryOnly=false reason="<why this agent needs ${toolName}>"`,
      ].join('\n');
    }),
  ];
  return lines.join('\n');
}
