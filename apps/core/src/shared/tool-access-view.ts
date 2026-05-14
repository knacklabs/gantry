import {
  ADMIN_MCP_TOOL_NAMES,
  adminMcpToolFullName,
  adminMcpToolIdForFullName,
  type AdminMcpToolName,
} from './admin-mcp-tools.js';
import {
  PROJECTED_BROWSER_MCP_TOOL_NAMES,
  isCanonicalBrowserCapabilityRule,
} from './agent-tool-references.js';

export interface RequestableAdminToolAccess {
  tool: string;
  toolId: string;
  requestPermission: string;
  note?: string;
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
  effectiveAllowedTools: string[];
  projectedRuntimeTools: string[];
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

export const BROWSER_TOOL_NAME = 'Browser';
export const BROWSER_REQUEST_PERMISSION_ARGS =
  'permissionKind=tool toolName=Browser toolCategory=browser temporaryOnly=false reason="<why this agent needs Browser>"';
export const BROWSER_REQUESTABLE_NOTE =
  'Browser approval exposes MyClaw-owned browser_* tools. Status is read-only; action calls launch the host-derived profile lazily.';

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

export function buildRequestableBrowserToolAccess(input: {
  configuredTools?: readonly string[];
  externalMcpAllowedTools?: readonly string[];
}): RequestableAdminToolAccess[] {
  void input.externalMcpAllowedTools;
  if (isBrowserCapabilitySelected(input.configuredTools ?? [])) {
    return [];
  }
  return [
    {
      tool: BROWSER_TOOL_NAME,
      toolId: `tool:${BROWSER_TOOL_NAME}`,
      requestPermission: BROWSER_REQUEST_PERMISSION_ARGS,
      note: BROWSER_REQUESTABLE_NOTE,
    },
  ];
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
  effectiveAllowedTools?: readonly string[];
  projectedRuntimeTools?: readonly string[];
  source?: string;
}): JobToolAccessView {
  const effectiveAllowedTools = uniqueStrings(
    input.effectiveAllowedTools ?? [],
  );
  return {
    inheritedAgentTools: uniqueStrings(input.inheritedAgentTools ?? []),
    effectiveAllowedTools,
    projectedRuntimeTools: uniqueStrings(
      input.projectedRuntimeTools ??
        projectedRuntimeToolsForRules(effectiveAllowedTools),
    ),
    source: input.source ?? 'inherited target agent capabilities',
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
    `  Effective allowed tools: ${formatList(view.effectiveAllowedTools)}`,
    `  Projected runtime tools: ${formatList(view.projectedRuntimeTools)}`,
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

function isBrowserCapabilitySelected(
  configuredTools: readonly string[],
): boolean {
  return configuredTools.some(isCanonicalBrowserCapabilityRule);
}

function projectedRuntimeToolsForRules(rules: readonly string[]): string[] {
  return isBrowserCapabilitySelected(rules)
    ? [...PROJECTED_BROWSER_MCP_TOOL_NAMES]
    : [];
}
