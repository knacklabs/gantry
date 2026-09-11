import {
  compareCatalogEntries,
  type AgentPromptCapabilityCatalog,
  type CatalogEntry,
} from './agent-prompt-capability-catalog.js';
import {
  DEFAULT_AGENT_ENGINE,
  type AgentEngine,
} from '../../shared/agent-engine.js';

export interface CapabilityCatalogRenderDiagnostics {
  rendered: CatalogSectionCounts;
  omitted: CatalogSectionCounts;
  sheddingStage: CapabilityCatalogSheddingStage;
}

export type CapabilityCatalogSheddingStage =
  | 'none'
  | 'requestable_actions'
  | 'discovery'
  | 'connected_sources'
  | 'installed_skills'
  | 'descriptions'
  | 'invocations'
  | 'compact_overflow';

export class CapabilityCatalogOverflowError extends Error {
  readonly code = 'capability_catalog_overflow';

  constructor(
    readonly grantedCount: number,
    readonly renderableCount: number,
    readonly sheddingStage: CapabilityCatalogSheddingStage,
  ) {
    super(
      `Capability catalog overflow: ${grantedCount} grants, ${renderableCount} renderable.`,
    );
    this.name = 'CapabilityCatalogOverflowError';
  }
}

export function composePromptWithRequiredCapabilityCatalog(input: {
  blocks: readonly string[];
  capabilityIndex: number;
  totalBudget: number;
  grantedCount: number;
  compactReadyLines: readonly string[];
}): string {
  if (input.totalBudget <= 0 || input.blocks.length === 0) return '';
  const capabilityBlock = input.blocks[input.capabilityIndex] ?? '';
  if (capabilityBlock.length > input.totalBudget) {
    const compactLength = input.compactReadyLines.join('\n').length;
    let remaining = Math.max(
      0,
      input.totalBudget - (capabilityBlock.length - compactLength),
    );
    let renderableCount = 0;
    for (const line of input.compactReadyLines) {
      const length = line.length + (renderableCount > 0 ? 1 : 0);
      if (length > remaining) break;
      remaining -= length;
      renderableCount += 1;
    }
    throw new CapabilityCatalogOverflowError(
      input.grantedCount,
      renderableCount,
      'compact_overflow',
    );
  }

  let output = '';
  for (const [index, block] of input.blocks.entries()) {
    const separator = output ? '\n\n' : '';
    const reserved =
      index < input.capabilityIndex ? capabilityBlock.length + 2 : 0;
    const available =
      input.totalBudget - output.length - separator.length - reserved;
    if (available <= 0) continue;
    const nextBlock = block.slice(0, available).trimEnd();
    if (!nextBlock) break;
    output += separator + nextBlock;
  }
  return output.trim();
}

interface CatalogSectionCounts {
  readyActions: number;
  requestableActions?: number;
  installedSkills: number;
  connectedMcpSources: number;
}

export function renderCapabilityGuidancePrompt(input: {
  catalog: AgentPromptCapabilityCatalog | undefined;
  accessPreset: 'full' | 'locked';
  mcpInventoryToolsMounted: boolean;
  budget: number;
  agentEngine?: AgentEngine;
}): {
  prompt: string;
  compactPrompt: string;
  compactReadyLines: string[];
  diagnostics: CapabilityCatalogRenderDiagnostics;
} {
  const readyActions = sortedCatalogEntries(input.catalog?.readyActions);
  const requestableActions =
    input.accessPreset === 'locked'
      ? []
      : sortedCatalogEntries(input.catalog?.requestableActions);
  const installedSkills = sortedCatalogEntries(input.catalog?.installedSkills);
  const connectedMcpSources = sortedCatalogEntries(
    input.catalog?.connectedMcpSources,
  );
  const intro = [
    '# Capability catalog',
    'This is a read-only snapshot for this agent; execution policy still applies.',
    'Use a matching ready action or installed skill without waiting for the user to name it.',
  ];
  const renderedRequestable = requestableActions.map(
    renderRequestableCatalogEntry,
  );
  const discovery = !input.mcpInventoryToolsMounted
    ? []
    : input.accessPreset === 'locked'
      ? [
          'Discovery',
          '- Search connected MCP inventory with mcp_search_tools. If no provisioned action fits, say what is unavailable.',
        ]
      : [
          'Discovery',
          '- Search connected MCP inventory with mcp_search_tools.',
          '- Callable now -> mcp_call_tool. Acquire first -> request_access for the reviewed capability.',
        ];
  const assemble = (options: {
    ready: readonly string[];
    skills: readonly string[];
    sources: readonly string[];
    requestables: readonly string[];
    discovery: readonly string[];
  }) =>
    [
      ...intro,
      '',
      'Ready actions',
      ...options.ready,
      '',
      'Requestable next-run actions',
      ...(options.requestables.length > 0 ? options.requestables : ['- none']),
      '',
      'Installed skills',
      ...(options.skills.length > 0 ? options.skills : ['- none']),
      '',
      'Connected MCP sources',
      ...(options.sources.length > 0 ? options.sources : ['- none']),
      '',
      ...options.discovery,
    ].join('\n');
  const readyWithDetails = readyActions.map((entry) =>
    renderReadyCatalogEntry(entry, input.agentEngine, true, true),
  );
  const readyWithoutDescriptions = readyActions.map((entry) =>
    renderReadyCatalogEntry(entry, input.agentEngine, false, true),
  );
  const compactReadyLines = readyActions.map((entry) =>
    renderReadyCatalogEntry(entry, input.agentEngine, false, false),
  );
  const renderedSkills = installedSkills.map((entry) =>
    renderCatalogEntry(entry, true),
  );
  const renderedSources = connectedMcpSources.map((entry) =>
    renderCatalogEntry(entry, true),
  );
  const stages = [
    {
      stage: 'none' as const,
      ready: readyWithDetails,
      requestables: renderedRequestable,
      discovery,
      skills: renderedSkills,
      sources: renderedSources,
    },
    {
      stage: 'requestable_actions' as const,
      ready: readyWithDetails,
      requestables: [],
      discovery,
      skills: renderedSkills,
      sources: renderedSources,
    },
    {
      stage: 'discovery' as const,
      ready: readyWithDetails,
      requestables: [],
      discovery: [],
      skills: renderedSkills,
      sources: renderedSources,
    },
    {
      stage: 'connected_sources' as const,
      ready: readyWithDetails,
      requestables: [],
      discovery: [],
      skills: renderedSkills,
      sources: [],
    },
    {
      stage: 'installed_skills' as const,
      ready: readyWithDetails,
      requestables: [],
      discovery: [],
      skills: [],
      sources: [],
    },
    {
      stage: 'descriptions' as const,
      ready: readyWithoutDescriptions,
      requestables: [],
      discovery: [],
      skills: [],
      sources: [],
    },
    {
      stage: 'invocations' as const,
      ready: compactReadyLines,
      requestables: [],
      discovery: [],
      skills: [],
      sources: [],
    },
  ];
  const compactPrompt = compactReadyLines.join('\n');
  const renderStage = (stage: (typeof stages)[number]) =>
    stage.stage === 'invocations' ? compactPrompt : assemble(stage);
  const budget =
    readyActions.length > 0
      ? Math.max(input.budget, compactPrompt.length)
      : input.budget;
  const selected =
    stages.find((stage) => renderStage(stage).length <= budget) ??
    stages.at(-1)!;
  const prompt = renderStage(selected);
  const renderedCounts = {
    readyActions: readyActions.length,
    ...(selected.requestables.length > 0
      ? { requestableActions: selected.requestables.length }
      : {}),
    installedSkills: selected.skills.length,
    connectedMcpSources: selected.sources.length,
  };
  return {
    prompt,
    compactPrompt,
    compactReadyLines,
    diagnostics: {
      rendered: renderedCounts,
      omitted: {
        readyActions: 0,
        ...(requestableActions.length > 0
          ? {
              requestableActions:
                requestableActions.length -
                (renderedCounts.requestableActions ?? 0),
            }
          : {}),
        installedSkills:
          installedSkills.length - renderedCounts.installedSkills,
        connectedMcpSources:
          connectedMcpSources.length - renderedCounts.connectedMcpSources,
      },
      sheddingStage: selected.stage,
    },
  };
}

function renderRequestableCatalogEntry(entry: CatalogEntry): string {
  const identity = oneLine(entry.stableRef);
  const displayName = oneLine(entry.displayName);
  const description = oneLine(entry.description);
  const target =
    entry.kind === 'requestable_tool'
      ? `target.kind=tool target.name="${identity}"`
      : `target.kind=capability target.id="${identity}"`;
  return `- ${identity} · ${displayName} — ${description} (${target})`;
}

function renderCatalogEntry(
  entry: CatalogEntry,
  includeDescription: boolean,
): string {
  const displayName = oneLine(entry.displayName);
  const account = entry.accountLabel ? ` (${oneLine(entry.accountLabel)})` : '';
  const label = `${displayName}${account}`;
  const description = includeDescription ? oneLine(entry.description) : '';
  return description ? `- ${label} — ${description}` : `- ${label}`;
}

function renderReadyCatalogEntry(
  entry: CatalogEntry,
  agentEngine: AgentEngine | undefined,
  includeDescription: boolean,
  includeInvocations: boolean,
): string {
  const account = entry.accountLabel ? ` (${oneLine(entry.accountLabel)})` : '';
  const description = includeDescription
    ? ` — ${oneLine(entry.description)}`
    : '';
  const line = `- ${oneLine(entry.category)} · ${oneLine(entry.displayName)}${account} [id: ${oneLine(entry.stableRef)}]${description}`;
  if (!includeInvocations) return line;
  const invocations = (entry.invocations ?? [])
    .map((invocation) => renderInvocation(invocation, agentEngine))
    .filter((value): value is string => Boolean(value));
  return invocations.length > 0 ? [line, ...invocations].join('\n') : line;
}

function renderInvocation(
  invocation: NonNullable<CatalogEntry['invocations']>[number],
  agentEngine: AgentEngine | undefined,
): string | undefined {
  switch (invocation.kind) {
    case 'local_cli': {
      const toolName = resolveLaneToolName(invocation.toolRef, agentEngine);
      return toolName
        ? `  invoke: ${toolName} with capabilityId="${oneLine(invocation.capabilityId)}" and args ${invocation.argumentPatterns.join(' or ')}`
        : undefined;
    }
    case 'mcp_pattern': {
      const toolName = resolveLaneToolName(invocation.toolRef, agentEngine);
      return toolName
        ? `  invoke: ${toolName} with serverName="${oneLine(invocation.serverName)}" and toolName matching ${invocation.toolPatterns.map((pattern) => `"${oneLine(pattern)}"`).join(' or ')}`
        : undefined;
    }
    case 'tool_rule':
    case 'adapter':
      return `  invoke: ${oneLine(invocation.toolName)} directly`;
  }
}

function resolveLaneToolName(
  toolRef: 'capability_run' | 'mcp_call_tool',
  agentEngine: AgentEngine | undefined,
): string | undefined {
  return agentEngine === DEFAULT_AGENT_ENGINE
    ? `mcp__gantry__${toolRef}`
    : undefined;
}

function sortedCatalogEntries(
  entries: readonly CatalogEntry[] | undefined,
): CatalogEntry[] {
  return [...(entries ?? [])].sort(compareCatalogEntries);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
