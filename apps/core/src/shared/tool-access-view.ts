import {
  ADMIN_MCP_TOOL_NAMES,
  adminMcpToolFullName,
  adminMcpToolIdForFullName,
  type AdminMcpToolName,
} from './admin-mcp-tools.js';
import {
  PROJECTED_BROWSER_MCP_TOOL_NAMES,
  isCanonicalBrowserCapabilityRule,
  parseReadableScopedToolRule,
  RUN_COMMAND_TOOL_NAME,
  sdkToolsForGantryFacadeTool,
} from './agent-tool-references.js';
import {
  canonicalizeGeneratedRuntimeSkillPaths,
  generatedRuntimeSkillPathDisplay,
} from './generated-runtime-paths.js';

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
  'RunCommand',
  'FileEdit',
  'FileWrite',
] as const;

export const BROWSER_TOOL_NAME = 'Browser';
export const BROWSER_REQUEST_PERMISSION_ARGS =
  'target.kind=capability target.id=browser.use temporaryOnly=false reason="<why this agent needs Browser>"';
export const BROWSER_REQUESTABLE_NOTE =
  'Browser approval exposes Gantry-owned browser_* tools. Status is read-only; action calls launch the host-derived profile lazily.';

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
      requestPermission: `target.kind=tool target.name="${fullName}" temporaryOnly=false reason="<why this agent needs ${toolName}>"`,
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
    configuredTools: uniqueDisplayRules(input.configuredTools ?? []),
    defaultTools: uniqueStrings(input.defaultTools ?? []),
    availableButGatedTools: uniqueStrings(input.availableButGatedTools ?? []),
    requestableAdminTools: uniqueRequestableAdminTools(
      input.requestableAdminTools ?? [],
    ),
    source: input.source,
  };
}

export function buildConfiguredAgentToolAccess(
  configuredTools: string[],
  requestableAdminTools: readonly RequestableAdminToolAccess[],
): AgentToolAccessView {
  return buildAgentToolAccessView({
    configuredTools,
    defaultTools: [],
    availableButGatedTools: PERMISSION_GATED_NATIVE_TOOLS.filter(
      (toolName) =>
        !configuredTools.some(
          (configured) =>
            configured === toolName || configured.startsWith(`${toolName}(`),
        ),
    ),
    requestableAdminTools,
    source: 'Postgres agent_tool_bindings projected from settings.yaml',
  });
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
    inheritedAgentTools: uniqueDisplayRules(input.inheritedAgentTools ?? []),
    effectiveAllowedTools: uniqueDisplayRules(effectiveAllowedTools),
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

export function formatJobToolAccess(
  view: JobToolAccessView | undefined,
): string {
  if (!view) return 'Tool access: (none)';
  return `Tool access: inherited ${formatList(view.inheritedAgentTools)}; effective ${formatList(view.effectiveAllowedTools)}; projected ${formatList(view.projectedRuntimeTools)}`;
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

function uniqueDisplayRules(values: readonly string[]): string[] {
  return uniqueStrings(values.map(formatToolRuleForUser));
}

function formatToolRuleForUser(value: string): string {
  const generatedSkillPath = generatedRuntimeSkillPathDisplay(value);
  if (!generatedSkillPath) return value;
  const canonical = canonicalizeGeneratedRuntimeSkillPaths(value);
  const scoped = parseReadableScopedToolRule(canonical);
  if (
    scoped?.toolName === RUN_COMMAND_TOOL_NAME &&
    /^chmod\s+\+x\s+/.test(scoped.scope)
  ) {
    return `Generated skill action setup (${generatedSkillPath})`;
  }
  return `Generated skill action (${generatedSkillPath})`;
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
  const projected = new Set<string>();
  if (isBrowserCapabilitySelected(rules)) {
    for (const toolName of PROJECTED_BROWSER_MCP_TOOL_NAMES) {
      projected.add(toolName);
    }
  }
  for (const rule of rules) {
    const scoped = parseReadableScopedToolRule(rule);
    if (scoped?.toolName === RUN_COMMAND_TOOL_NAME) projected.add('Bash');
    for (const toolName of sdkToolsForGantryFacadeTool(rule)) {
      projected.add(toolName);
    }
  }
  return [...projected];
}
