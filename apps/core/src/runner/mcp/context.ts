import path from 'path';
import {
  gantryMcpFullToolName,
  parseEnabledGantryMcpToolNames,
} from '../gantry-mcp-tool-surface.js';
import { readLiveToolRules } from '../../shared/live-tool-rules.js';
import { normalizeMemoryIpcActions } from '../../shared/memory-ipc-actions.js';
import {
  ADMIN_MCP_TOOL_NAMES,
  adminMcpToolNameFromFullName,
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

export const IPC_DIR = requirePathEnv('GANTRY_IPC_DIR');
export const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
export const TASKS_DIR = path.join(IPC_DIR, 'tasks');
export const MEMORY_REQUESTS_DIR = path.join(IPC_DIR, 'memory-requests');
export const MEMORY_RESPONSES_DIR = path.join(IPC_DIR, 'memory-responses');
export const BROWSER_REQUESTS_DIR = path.join(IPC_DIR, 'browser-requests');
export const BROWSER_RESPONSES_DIR = path.join(IPC_DIR, 'browser-responses');
export const TASK_RESPONSES_DIR = path.join(IPC_DIR, 'task-responses');
export const IPC_AUTH_TOKEN = process.env.GANTRY_IPC_AUTH_TOKEN || '';
export const BROWSER_IPC_AUTH_TOKEN =
  process.env.GANTRY_BROWSER_IPC_AUTH_TOKEN || IPC_AUTH_TOKEN;
export const MEMORY_IPC_AUTH_TOKEN =
  process.env.GANTRY_MEMORY_IPC_AUTH_TOKEN || IPC_AUTH_TOKEN;
export const IPC_RESPONSE_VERIFY_KEY =
  process.env.GANTRY_IPC_RESPONSE_VERIFY_KEY || '';
export const IPC_RESPONSE_KEY_ID = process.env.GANTRY_IPC_RESPONSE_KEY_ID || '';

export const chatJid = process.env.GANTRY_CHAT_JID!;
export const groupFolder = process.env.GANTRY_GROUP_FOLDER!;
export const appId = process.env.GANTRY_APP_ID?.trim() || undefined;
export const agentId = process.env.GANTRY_AGENT_ID?.trim() || undefined;
export const jobId = process.env.GANTRY_JOB_ID?.trim() || undefined;
export const threadId = process.env.GANTRY_THREAD_ID?.trim() || undefined;
export const memoryUserId =
  process.env.GANTRY_MEMORY_USER_ID?.trim() || undefined;
export const memoryDefaultScope =
  process.env.GANTRY_MEMORY_DEFAULT_SCOPE === 'user' ? 'user' : 'group';
export const memoryReviewerIsControlApprover =
  process.env.GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER === '1';
export const memoryIpcAllowedActions = normalizeMemoryIpcActions(
  parseJsonStringArray(process.env.GANTRY_MEMORY_IPC_ACTIONS_JSON),
);
export const browserProfileName =
  process.env.GANTRY_BROWSER_PROFILE_NAME?.trim() || undefined;
export const enabledAdminMcpTools = parseEnabledAdminMcpTools(
  process.env.GANTRY_ADMIN_MCP_TOOLS_JSON,
);
export const enabledGantryMcpTools = parseEnabledGantryMcpToolNames(
  process.env.GANTRY_MCP_TOOL_NAMES_JSON,
);
export const configuredAllowedTools = parseConfiguredAllowedTools(
  process.env.GANTRY_CONFIGURED_ALLOWED_TOOLS_JSON,
);
export const selectedSkillIds = parseJsonStringArray(
  process.env.GANTRY_SELECTED_SKILLS_JSON,
);
export const selectedMcpServerIds = parseJsonStringArray(
  process.env.GANTRY_SELECTED_MCP_SERVERS_JSON,
);

export function isAdminMcpToolEnabled(toolName: AdminMcpToolName): boolean {
  return currentEnabledAdminMcpTools().has(toolName);
}

export function currentEnabledAdminMcpTools(): Set<AdminMcpToolName> {
  const enabled = new Set(enabledAdminMcpTools);
  for (const rule of readLiveToolRules({
    ipcDir: IPC_DIR,
    runHandle: process.env.GANTRY_AGENT_RUN_HANDLE,
  })) {
    const adminToolName = adminMcpToolNameFromFullName(rule);
    if (adminToolName) enabled.add(adminToolName);
  }
  return enabled;
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
  const currentAdminTools = currentEnabledAdminMcpTools();
  const availableToolNames = [...enabledGantryMcpTools].filter(
    (toolName) => !isAdminMcpToolName(toolName),
  );
  for (const adminToolName of currentAdminTools) {
    availableToolNames.push(adminToolName);
  }
  const requestableBrowserTools = buildRequestableBrowserToolAccess({
    configuredTools: configuredAllowedTools,
  });
  const lines = [
    'Runtime capability context for this agent. Use these details to choose tools; do not quote this block directly to users.',
    '',
    'Gantry MCP tools available in this run:',
    ...availableToolNames
      .sort()
      .map((toolName) => `- available: ${gantryMcpFullToolName(toolName)}`),
    '',
    'Semantic capability tools:',
    '- capability_search: find built-in capabilities such as google.sheets.write',
    '- propose_capability: request an approved semantic capability or propose a reviewed local_cli capability with pinned executable details',
    '- manage_capability: view/change/revoke/test/audit guidance for selected capabilities',
    '',
    'Scheduler monitoring:',
    '- Use scheduler_get_job, scheduler_list_runs, scheduler_list_events, and scheduler_wait_for_events to inspect or wait for jobs.',
    '- Never request Bash just to sleep, wait, poll, or monitor scheduler job completion.',
    '',
    'Gantry admin tool capabilities:',
    ...ADMIN_MCP_TOOL_NAMES.map((toolName) => {
      const fullName = `mcp__gantry__${toolName}`;
      if (currentAdminTools.has(toolName)) {
        return `- available: ${fullName}`;
      }
      return `- requestable: ${fullName} (ask a configured approver to approve this capability)`;
    }),
    '',
    'Memory IPC actions available in this run:',
    ...memoryIpcAllowedActions
      .slice()
      .sort()
      .map((action) => `- available: ${action}`),
    '',
    'Installed skills ready for this agent:',
    ...(selectedSkillIds.length > 0
      ? selectedSkillIds
          .slice()
          .sort()
          .map((skillId) => `- ready: ${skillId}`)
      : ['- none installed yet']),
    '',
    'Connected MCP services ready for this agent:',
    ...(selectedMcpServerIds.length > 0
      ? selectedMcpServerIds
          .slice()
          .sort()
          .map((serverId) => `- ready: ${serverId}`)
      : ['- none connected yet']),
    '',
    'Browser capability:',
    ...(requestableBrowserTools.length > 0
      ? requestableBrowserTools.flatMap((tool) => [
          `- requestable: ${tool.tool}`,
          `  note: ${tool.note}`,
        ])
      : [
          '- ready: Browser',
          '  note: Browser exposes Gantry-owned browser_* tools. Status is read-only; other actions launch the host-derived profile lazily.',
        ]),
  ];
  const view = buildAgentToolAccessView({
    configuredTools: configuredAllowedTools,
    defaultTools: availableToolNames
      .filter((toolName) => !ADMIN_MCP_TOOL_NAMES.includes(toolName as never))
      .map(gantryMcpFullToolName),
    availableButGatedTools: PERMISSION_GATED_NATIVE_TOOLS.filter(
      (toolName) =>
        !configuredAllowedTools.some(
          (configured) =>
            configured === toolName || configured.startsWith(`${toolName}(`),
        ),
    ),
    requestableAdminTools: [
      ...buildRequestableAdminToolAccess(currentAdminTools),
      ...requestableBrowserTools,
    ],
    source: 'settings.yaml current agent tools plus runtime defaults',
  });
  return [...lines, '', formatAgentToolAccess(view)].join('\n');
}
