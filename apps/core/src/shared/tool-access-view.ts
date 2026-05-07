import {
  ADMIN_MCP_TOOL_NAMES,
  adminMcpToolFullName,
  adminMcpToolIdForFullName,
  type AdminMcpToolName,
} from './admin-mcp-tools.js';

export interface RequestableAdminToolAccess {
  tool: string;
  toolId: string;
  requestPermission: string;
}

export interface AgentToolAccessView {
  configuredTools: string[];
  defaultTools: string[];
  availableButGatedTools: string[];
  requestableAdminTools: RequestableAdminToolAccess[];
  source: string;
}

export interface JobToolAccessView {
  inheritedAgentTools: string[];
  jobExtraTools: string[];
  effectiveAllowedTools: string[];
  source: string;
}

export const PERMISSION_GATED_NATIVE_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'LS',
  'MultiEdit',
  'NotebookEdit',
] as const;

export function buildRequestableAdminToolAccess(
  enabledAdminTools: ReadonlySet<AdminMcpToolName | string>,
): RequestableAdminToolAccess[] {
  return ADMIN_MCP_TOOL_NAMES.filter(
    (toolName) => !enabledAdminTools.has(toolName),
  ).map((toolName) => {
    const fullName = adminMcpToolFullName(toolName);
    return {
      tool: fullName,
      toolId: adminMcpToolIdForFullName(fullName),
      requestPermission: `permissionKind=tool toolName=${fullName} temporaryOnly=false reason="<why this agent needs ${toolName}>"`,
    };
  });
}

export function buildAgentToolAccessView(input: {
  configuredTools?: readonly string[];
  defaultTools?: readonly string[];
  availableButGatedTools?: readonly string[];
  requestableAdminTools?: readonly RequestableAdminToolAccess[];
  source: string;
}): AgentToolAccessView {
  return {
    configuredTools: uniqueStrings(input.configuredTools ?? []),
    defaultTools: uniqueStrings(input.defaultTools ?? []),
    availableButGatedTools: uniqueStrings(input.availableButGatedTools ?? []),
    requestableAdminTools: uniqueRequestableAdminTools(
      input.requestableAdminTools ?? [],
    ),
    source: input.source,
  };
}

export function buildJobToolAccessView(input: {
  inheritedAgentTools?: readonly string[];
  jobExtraTools?: readonly string[];
  effectiveAllowedTools?: readonly string[];
  source?: string;
}): JobToolAccessView {
  return {
    inheritedAgentTools: uniqueStrings(input.inheritedAgentTools ?? []),
    jobExtraTools: uniqueStrings(input.jobExtraTools ?? []),
    effectiveAllowedTools: uniqueStrings(input.effectiveAllowedTools ?? []),
    source:
      input.source ??
      'inherited agent grants plus target_json.capabilityPolicy.allowedTools',
  };
}

export function formatAgentToolAccess(view: AgentToolAccessView): string {
  return [
    'Tool Access:',
    `  Source: ${view.source}`,
    `  Configured tools: ${formatList(view.configuredTools)}`,
    `  Default tools: ${formatList(view.defaultTools)}`,
    `  Available but gated: ${formatList(view.availableButGatedTools)}`,
    `  Requestable admin tools: ${formatList(
      view.requestableAdminTools.map((tool) => tool.tool),
    )}`,
  ].join('\n');
}

export function formatJobToolAccess(view: JobToolAccessView): string {
  return [
    'Tool Access:',
    `  Source: ${view.source}`,
    `  Inherited agent tools: ${formatList(view.inheritedAgentTools)}`,
    `  Job extra tools: ${formatList(view.jobExtraTools)}`,
    `  Effective allowed tools: ${formatList(view.effectiveAllowedTools)}`,
  ].join('\n');
}

export function compactToolList(
  values: readonly string[] | undefined,
  maxLength = 36,
): string {
  const label = uniqueStrings(values ?? []).join(', ');
  if (!label) return '-';
  return label.length > maxLength
    ? `${label.slice(0, maxLength - 3)}...`
    : label;
}

function formatList(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function uniqueStrings(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

function uniqueRequestableAdminTools(
  values: readonly RequestableAdminToolAccess[],
): RequestableAdminToolAccess[] {
  const out = new Map<string, RequestableAdminToolAccess>();
  for (const value of values) {
    if (!value.tool.trim()) continue;
    out.set(value.tool, value);
  }
  return [...out.values()];
}
