import {
  compareCatalogEntries,
  type AgentPromptCapabilityCatalog,
  type CatalogEntry,
} from './agent-prompt-capability-catalog.js';

export interface CapabilityCatalogRenderDiagnostics {
  rendered: CatalogSectionCounts;
  omitted: CatalogSectionCounts;
}

interface CatalogSectionCounts {
  readyActions: number;
  installedSkills: number;
  connectedMcpSources: number;
}

type CatalogPromptSection = 'ready' | 'skill' | 'mcp';

export function renderCapabilityGuidancePrompt(input: {
  catalog: AgentPromptCapabilityCatalog | undefined;
  accessPreset: 'full' | 'locked';
  mcpInventoryToolsMounted: boolean;
  budget: number;
}): { prompt: string; diagnostics: CapabilityCatalogRenderDiagnostics } {
  const readyActions = sortedCatalogEntries(input.catalog?.readyActions);
  const installedSkills = sortedCatalogEntries(input.catalog?.installedSkills);
  const connectedMcpSources = sortedCatalogEntries(
    input.catalog?.connectedMcpSources,
  );
  const intro = [
    '# Capability catalog',
    'This is a read-only snapshot for this agent; execution policy still applies.',
    'Use a matching ready action or installed skill without waiting for the user to name it.',
  ];
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
  const assemble = (
    ready: readonly string[],
    skills: readonly string[],
    sources: readonly string[],
  ) =>
    [
      ...intro,
      '',
      'Ready actions',
      ...ready,
      '',
      'Installed skills',
      ...skills,
      '',
      'Connected MCP sources',
      ...sources,
      '',
      ...discovery,
    ].join('\n');
  const fits = (
    ready: readonly string[],
    skills: readonly string[],
    sources: readonly string[],
  ) => assemble(ready, skills, sources).length <= input.budget;

  const sourceReservation = reserveConnectedSourcePresence({
    entries: connectedMcpSources,
    fits,
  });
  let readyDescriptionLimit = 160;
  let renderedReady = readyActions.map((entry) =>
    renderCatalogEntry(entry, 'ready', readyDescriptionLimit),
  );
  while (
    readyDescriptionLimit > 0 &&
    !fits(renderedReady, [], sourceReservation.lines)
  ) {
    readyDescriptionLimit = Math.max(0, readyDescriptionLimit - 20);
    renderedReady = readyActions.map((entry) =>
      renderCatalogEntry(entry, 'ready', readyDescriptionLimit),
    );
  }
  if (!fits(renderedReady, [], sourceReservation.lines)) {
    renderedReady = appendWholeEntriesWithinBudget({
      entries: readyActions,
      currentReady: [],
      currentSkills: [],
      currentSources: sourceReservation.lines,
      section: 'ready',
      descriptionLimit: 0,
      summaryLabel: 'ready actions',
      fits,
    });
  }

  const renderedSkills = appendWholeEntriesWithinBudget({
    entries: installedSkills,
    currentReady: renderedReady,
    currentSkills: [],
    currentSources: sourceReservation.lines,
    section: 'skill',
    descriptionLimit: 160,
    summaryLabel: 'installed skills',
    fits,
  });
  const renderedSources = appendWholeEntriesWithinBudget({
    entries: connectedMcpSources,
    currentReady: renderedReady,
    currentSkills: renderedSkills,
    currentSources: [],
    section: 'mcp',
    descriptionLimit: sourceReservation.descriptionLimit,
    summaryLabel: 'connected sources',
    fits,
  });
  const renderedCounts = {
    readyActions: renderedEntryCount(renderedReady),
    installedSkills: renderedEntryCount(renderedSkills),
    connectedMcpSources: renderedEntryCount(renderedSources),
  };
  return {
    prompt: assemble(renderedReady, renderedSkills, renderedSources),
    diagnostics: {
      rendered: renderedCounts,
      omitted: {
        readyActions: readyActions.length - renderedCounts.readyActions,
        installedSkills:
          installedSkills.length - renderedCounts.installedSkills,
        connectedMcpSources:
          connectedMcpSources.length - renderedCounts.connectedMcpSources,
      },
    },
  };
}

function reserveConnectedSourcePresence(input: {
  entries: readonly CatalogEntry[];
  fits: (
    ready: readonly string[],
    skills: readonly string[],
    sources: readonly string[],
  ) => boolean;
}): { lines: string[]; descriptionLimit: number } {
  if (input.entries.length === 0) return { lines: [], descriptionLimit: 160 };
  for (const descriptionLimit of [160, 0]) {
    const lines = [
      renderCatalogEntry(input.entries[0]!, 'mcp', descriptionLimit),
    ];
    if (input.entries.length > 1) {
      lines.push(`- +${input.entries.length - 1} more connected sources`);
    }
    if (input.fits([], [], lines)) return { lines, descriptionLimit };
  }
  const summary = `- +${input.entries.length} more connected sources`;
  return {
    lines: input.fits([], [], [summary]) ? [summary] : [],
    descriptionLimit: 0,
  };
}

function appendWholeEntriesWithinBudget(input: {
  entries: readonly CatalogEntry[];
  currentReady: readonly string[];
  currentSkills: readonly string[];
  currentSources: readonly string[];
  section: CatalogPromptSection;
  descriptionLimit: number;
  summaryLabel: string;
  fits: (
    ready: readonly string[],
    skills: readonly string[],
    sources: readonly string[],
  ) => boolean;
}): string[] {
  const rendered: string[] = [];
  const candidateFits = (lines: readonly string[]) => {
    const ready = input.section === 'ready' ? lines : input.currentReady;
    const skills = input.section === 'skill' ? lines : input.currentSkills;
    const sources = input.section === 'mcp' ? lines : input.currentSources;
    return input.fits(ready, skills, sources);
  };
  for (let index = 0; index < input.entries.length; index += 1) {
    const line = renderCatalogEntry(
      input.entries[index]!,
      input.section,
      input.descriptionLimit,
    );
    const remaining = input.entries.length - index - 1;
    const candidate = [
      ...rendered,
      line,
      ...(remaining > 0 ? [`- +${remaining} more ${input.summaryLabel}`] : []),
    ];
    if (!candidateFits(candidate)) break;
    rendered.push(line);
  }
  const omitted = input.entries.length - rendered.length;
  if (omitted <= 0) return rendered;
  const summary = `- +${omitted} more ${input.summaryLabel}`;
  while (rendered.length > 0 && !candidateFits([...rendered, summary])) {
    rendered.pop();
  }
  return candidateFits([...rendered, summary])
    ? [...rendered, summary]
    : rendered;
}

function renderCatalogEntry(
  entry: CatalogEntry,
  section: CatalogPromptSection,
  descriptionLimit: number,
): string {
  const displayName = oneLine(entry.displayName);
  const account = entry.accountLabel ? ` (${oneLine(entry.accountLabel)})` : '';
  const label =
    section === 'ready'
      ? `${oneLine(entry.category)} · ${displayName}${account}`
      : `${displayName}${account}`;
  const description = truncateCatalogDescription(
    oneLine(entry.description),
    descriptionLimit,
  );
  return description ? `- ${label} — ${description}` : `- ${label}`;
}

function sortedCatalogEntries(
  entries: readonly CatalogEntry[] | undefined,
): CatalogEntry[] {
  return [...(entries ?? [])].sort(compareCatalogEntries);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateCatalogDescription(value: string, limit: number): string {
  if (limit <= 0) return '';
  if (value.length <= limit) return value;
  if (limit <= 3) return value.slice(0, limit);
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function renderedEntryCount(lines: readonly string[]): number {
  return lines.filter((line) => !/^- \+\d+ more /.test(line)).length;
}
