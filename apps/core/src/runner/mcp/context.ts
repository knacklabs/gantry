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
import {
  parseSemanticCapabilityDefinitionsRecord,
  type SemanticCapabilityDefinition,
} from '../../shared/semantic-capabilities.js';

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

if (process.env.GANTRY_GROUP_FOLDER !== undefined) {
  throw new Error(
    'GANTRY_GROUP_FOLDER is no longer supported. Use GANTRY_WORKSPACE_KEY.',
  );
}

export const chatJid = process.env.GANTRY_CHAT_JID!;
export const workspaceFolder = process.env.GANTRY_WORKSPACE_KEY!;
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
export const attachedSkillSourceIds = parseJsonStringArray(
  process.env.GANTRY_SELECTED_SKILLS_JSON,
);
export const selectedSkillDisplays = parseJsonStringArray(
  process.env.GANTRY_SELECTED_SKILL_DISPLAYS_JSON,
);
export const attachedMcpSourceIds = parseJsonStringArray(
  process.env.GANTRY_SELECTED_MCP_SERVERS_JSON,
);
export const availableSemanticCapabilities = parseSemanticCapabilities(
  process.env.GANTRY_SEMANTIC_CAPABILITIES_JSON,
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

function parseSemanticCapabilities(
  raw: string | undefined,
): SemanticCapabilityDefinition[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const record = Object.fromEntries(
        parsed
          .filter((item): item is SemanticCapabilityDefinition =>
            Boolean(
              item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof item.capabilityId === 'string',
            ),
          )
          .map((item) => [item.capabilityId, item]),
      );
      return Object.values(
        parseSemanticCapabilityDefinitionsRecord(record) ?? {},
      );
    }
    return Object.values(
      parseSemanticCapabilityDefinitionsRecord(parsed) ?? {},
    );
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

function mcpSourceNameFromCapability(
  capability: SemanticCapabilityDefinition,
): string | undefined {
  const source = capability.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (record.source !== 'mcp') return undefined;
  const serverName =
    typeof record.serverName === 'string' ? record.serverName.trim() : '';
  return serverName || undefined;
}

function mcpToolNamesFromCapability(
  capability: SemanticCapabilityDefinition,
): string[] {
  return [
    ...new Set(
      capability.implementationBindings
        .map((binding) =>
          binding.kind === 'mcp_tool' && binding.mcpTool
            ? binding.mcpTool.trim()
            : '',
        )
        .filter(Boolean),
    ),
  ];
}

function selectedMcpCapabilityLines(): string[] {
  const selectedByName = new Map<string, SemanticCapabilityDefinition[]>();
  for (const capability of availableSemanticCapabilities) {
    const sourceName = mcpSourceNameFromCapability(capability);
    if (!sourceName) continue;
    const existing = selectedByName.get(sourceName) ?? [];
    existing.push(capability);
    selectedByName.set(sourceName, existing);
  }

  if (selectedByName.size === 0) {
    return attachedMcpSourceIds.length > 0
      ? attachedMcpSourceIds
          .slice()
          .sort()
          .map((serverId) => `- ready source: ${serverId}`)
      : ['- none connected yet'];
  }

  return [...selectedByName.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([serverName, capabilities]) => {
      const capabilityIds = capabilities
        .map((capability) => capability.capabilityId)
        .sort();
      const toolNames = capabilities
        .flatMap((capability) => mcpToolNamesFromCapability(capability))
        .sort();
      return [
        `- ready source: ${serverName}`,
        `  selected capabilities: ${capabilityIds.join(', ')}`,
        `  use: mcp_list_tools with serverName="${serverName}", then mcp_call_tool with serverName="${serverName}"`,
        ...(toolNames.length > 0
          ? [`  approved tool rules: ${toolNames.join(', ')}`]
          : []),
      ];
    });
}

export function capabilityStatusText(): string {
  const currentAdminTools = currentEnabledAdminMcpTools();
  const selectedSkillStatusItems =
    selectedSkillDisplays.length > 0
      ? selectedSkillDisplays
      : attachedSkillSourceIds;
  const availableToolNames = [...enabledGantryMcpTools].filter(
    (toolName) => !isAdminMcpToolName(toolName),
  );
  for (const adminToolName of currentAdminTools) {
    availableToolNames.push(adminToolName);
  }
  const normalActionToolNames = availableToolNames.filter(
    (toolName) =>
      toolName === 'send_message' ||
      toolName === 'ask_user_question' ||
      toolName === 'memory_search' ||
      toolName === 'memory_save' ||
      toolName === 'continuity_summary' ||
      toolName === 'procedure_save' ||
      toolName === 'file' ||
      toolName === 'request_access' ||
      toolName.startsWith('scheduler_'),
  );
  const requestableBrowserTools = buildRequestableBrowserToolAccess({
    configuredTools: configuredAllowedTools,
  });
  const lines = [
    'Runtime capability context for this agent. Use available actions first; do not quote this block directly to users. Summarize access in plain language; keep raw capability ids and the Tool Access selected-capability block behind details and share verbatim only on explicit request.',
    '',
    'Core actions available in this run:',
    ...normalActionToolNames
      .sort()
      .map((toolName) => `- available: ${gantryMcpFullToolName(toolName)}`),
    '',
    'Agent access model:',
    '- Use an available action when one fits.',
    '- If the action is missing, request_access target.kind=capability for the reviewed capability id.',
    '- If setup is missing, request source setup through the Gantry access flow; setup records inventory, not authority.',
    '- Use request_access target.kind=run_command only as a temporary exact-command fallback when no reviewed capability fits.',
    '- Use admin_permission_list (read-only, no grant needed) to review current permissions, suggest cleanup of unused or overly broad access, or spot missing access; report findings in plain language.',
    '- Treat skill commands, MCP tool names, local CLI commands, browser internals, and network hosts as review/audit metadata unless a reviewed capability grants the action.',
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
    ...(selectedSkillStatusItems.length > 0
      ? selectedSkillStatusItems
          .slice()
          .sort()
          .map((skill) => `- ready: ${skill}`)
      : ['- none installed yet']),
    '',
    'Connected MCP services ready for this agent:',
    ...selectedMcpCapabilityLines(),
    ...(attachedMcpSourceIds.length > 0
      ? [
          `Attached MCP source ids: ${attachedMcpSourceIds.slice().sort().join(', ')}`,
          'MCP source rule: ready sources are already attached. Inspect them with mcp_list_tools and call approved actions through mcp_call_tool. Do not request the same MCP capability again unless the proxy response says access is missing. Do not use Bash, RunCommand, curl, node, browser automation, or file tools to call or inspect ready MCP sources.',
        ]
      : []),
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
    defaultTools: normalActionToolNames
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
    source:
      'settings.yaml selected capabilities plus action-first runtime defaults',
  });
  return [...lines, '', formatAgentToolAccess(view)].join('\n');
}
