import path from 'path';
import {
  myclawMcpFullToolName,
  parseEnabledMyClawMcpToolNames,
} from '../myclaw-mcp-tool-surface.js';
import { normalizeMemoryIpcActions } from '../../shared/memory-ipc-actions.js';
import {
  ADMIN_MCP_TOOL_NAMES,
  isAdminMcpToolName,
  type AdminMcpToolName,
} from '../../shared/admin-mcp-tools.js';
import {
  buildAgentToolAccessView,
  buildRequestableBrowserToolAccess,
  buildRequestableAdminToolAccess,
  formatAgentToolAccess,
  PERMISSION_GATED_NATIVE_TOOLS,
} from '../../shared/tool-access-view.js';

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
export const IPC_RESPONSE_KEY_ID = process.env.MYCLAW_IPC_RESPONSE_KEY_ID || '';

export const chatJid = process.env.MYCLAW_CHAT_JID!;
export const groupFolder = process.env.MYCLAW_GROUP_FOLDER!;
export const appId = process.env.MYCLAW_APP_ID?.trim() || undefined;
export const agentId = process.env.MYCLAW_AGENT_ID?.trim() || undefined;
export const threadId = process.env.MYCLAW_THREAD_ID?.trim() || undefined;
export const memoryUserId =
  process.env.MYCLAW_MEMORY_USER_ID?.trim() || undefined;
export const memoryDefaultScope =
  process.env.MYCLAW_MEMORY_DEFAULT_SCOPE === 'user' ? 'user' : 'group';
export const memoryReviewerIsControlApprover =
  process.env.MYCLAW_MEMORY_REVIEWER_IS_CONTROL_APPROVER === '1';
export const memoryIpcAllowedActions = normalizeMemoryIpcActions(
  parseJsonStringArray(process.env.MYCLAW_MEMORY_IPC_ACTIONS_JSON),
);
export const browserProfileName =
  process.env.MYCLAW_BROWSER_PROFILE_NAME?.trim() || undefined;
export const enabledAdminMcpTools = parseEnabledAdminMcpTools(
  process.env.MYCLAW_ADMIN_MCP_TOOLS_JSON,
);
export const enabledMyClawMcpTools = parseEnabledMyClawMcpToolNames(
  process.env.MYCLAW_MCP_TOOL_NAMES_JSON,
);
export const configuredAllowedTools = parseConfiguredAllowedTools(
  process.env.MYCLAW_CONFIGURED_ALLOWED_TOOLS_JSON,
);
export const selectedSkillIds = parseJsonStringArray(
  process.env.MYCLAW_SELECTED_SKILLS_JSON,
);
export const selectedMcpServerIds = parseJsonStringArray(
  process.env.MYCLAW_SELECTED_MCP_SERVERS_JSON,
);

export function isAdminMcpToolEnabled(toolName: AdminMcpToolName): boolean {
  return enabledAdminMcpTools.has(toolName);
}

function parseConfiguredAllowedTools(raw: string | undefined): string[] {
  return parseJsonStringArray(raw);
}

function parseJsonStringArray(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
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
  const availableToolNames = [...enabledMyClawMcpTools].filter(
    (toolName) => !isAdminMcpToolName(toolName),
  );
  for (const adminToolName of enabledAdminMcpTools) {
    availableToolNames.push(adminToolName);
  }
  const requestableBrowserTools = buildRequestableBrowserToolAccess({
    configuredTools: configuredAllowedTools,
  });
  const lines = [
    'MyClaw MCP tools available in this run:',
    ...availableToolNames
      .sort()
      .map((toolName) => `- available: ${myclawMcpFullToolName(toolName)}`),
    '',
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
    '',
    'Memory IPC actions available in this run:',
    ...memoryIpcAllowedActions
      .slice()
      .sort()
      .map((action) => `- available: ${action}`),
    '',
    'Selected skills for this agent:',
    ...(selectedSkillIds.length > 0
      ? selectedSkillIds
          .slice()
          .sort()
          .map((skillId) => `- selected: ${skillId}`)
      : ['- none']),
    '',
    'Selected MCP servers for this agent:',
    ...(selectedMcpServerIds.length > 0
      ? selectedMcpServerIds
          .slice()
          .sort()
          .map((serverId) => `- selected: ${serverId}`)
      : ['- none']),
    '',
    'Browser capability:',
    ...(requestableBrowserTools.length > 0
      ? requestableBrowserTools.flatMap((tool) => [
          `- requestable: ${tool.tool}`,
          `  tool_id: ${tool.toolId}`,
          `  request_permission: ${tool.requestPermission}`,
          `  note: ${tool.note}`,
        ])
      : [
          '- selected: Browser',
          '  note: Browser exposes MyClaw-owned browser_* tools. Status is read-only; other actions launch the host-derived profile lazily.',
        ]),
  ];
  const view = buildAgentToolAccessView({
    configuredTools: configuredAllowedTools,
    defaultTools: availableToolNames
      .filter((toolName) => !ADMIN_MCP_TOOL_NAMES.includes(toolName as never))
      .map(myclawMcpFullToolName),
    availableButGatedTools: PERMISSION_GATED_NATIVE_TOOLS.filter(
      (toolName) =>
        !configuredAllowedTools.some(
          (configured) =>
            configured === toolName || configured.startsWith(`${toolName}(`),
        ),
    ),
    requestableAdminTools: [
      ...buildRequestableAdminToolAccess(enabledAdminMcpTools),
      ...requestableBrowserTools,
    ],
    source: 'settings.yaml current agent tools plus runtime defaults',
  });
  return [...lines, '', formatAgentToolAccess(view)].join('\n');
}
