export type AgentStatus = 'deployed' | 'draft' | 'paused' | 'blocked';

export type AgentPreview = {
  id: string;
  name: string;
  description: string;
  status: AgentStatus;
  modelAlias: string;
  agentHarness: 'auto' | 'anthropic_sdk' | 'deepagents';
  persona: string;
  profile: {
    soul: string;
    instructions: string;
  };
  sources: string[];
  capabilities: string[];
  skills: string[];
  mcpServers: string[];
  conversations: string[];
  lastRun: string;
  runsToday: number;
};

export type SourcePreview = {
  id: string;
  name: string;
  kind: 'Built-in tools' | 'Skill catalog' | 'MCP server' | 'Local CLI';
  description: string;
  version: string;
  status: 'ready' | 'attention' | 'blocked';
  selectedBy: number;
  capabilities: string[];
  blocker?: string;
};

export const agents: AgentPreview[] = [
  {
    id: 'support-triage',
    name: 'Support triage',
    description:
      'Classifies requests, gathers evidence, and drafts support responses.',
    status: 'deployed',
    modelAlias: 'sonnet',
    agentHarness: 'auto',
    persona: 'Calm, concise, and evidence-first.',
    profile: {
      soul: 'Be useful under pressure. Keep operators oriented and customers respected.',
      instructions:
        'Triage the request, gather evidence, and ask before taking a risky action.',
    },
    sources: ['gantry-core-tools', 'support-playbook'],
    capabilities: [
      'Send messages',
      'Read conversation history',
      'Create files',
    ],
    skills: ['Support triage', 'Incident summary'],
    mcpServers: [],
    conversations: ['#product-support'],
    lastRun: '11 min ago',
    runsToday: 64,
  },
  {
    id: 'research-assistant',
    name: 'Research assistant',
    description:
      'Researches topics, compares sources, and produces cited briefs.',
    status: 'deployed',
    modelAlias: 'opus',
    agentHarness: 'anthropic_sdk',
    persona: 'Curious, skeptical, and precise with sources.',
    profile: {
      soul: 'Follow evidence wherever it leads and make uncertainty visible.',
      instructions: 'Prefer primary sources and separate facts from inference.',
    },
    sources: ['gantry-core-tools', 'research-library', 'browser-catalog'],
    capabilities: ['Read conversation history', 'Create files', 'Browser'],
    skills: ['Source review', 'Research brief'],
    mcpServers: ['Knowledge base'],
    conversations: ['Research room', 'Personal notes'],
    lastRun: '43 min ago',
    runsToday: 31,
  },
  {
    id: 'operations-analyst',
    name: 'Operations analyst',
    description:
      'Builds recurring operational summaries and tracks exceptions.',
    status: 'blocked',
    modelAlias: 'gpt-5',
    agentHarness: 'deepagents',
    persona: 'Methodical, direct, and careful with business data.',
    profile: {
      soul: 'Turn operational noise into decisions without hiding gaps.',
      instructions:
        'Validate the reporting scope before calculating or publishing results.',
    },
    sources: ['gantry-core-tools', 'reporting-cli'],
    capabilities: ['Read conversation history', 'Create files'],
    skills: ['Variance analysis'],
    mcpServers: [],
    conversations: ['Finance review'],
    lastRun: '1 hr ago',
    runsToday: 18,
  },
  {
    id: 'release-coordinator',
    name: 'Release coordinator',
    description:
      'A draft agent for coordinating release readiness and handoffs.',
    status: 'draft',
    modelAlias: 'sonnet',
    agentHarness: 'auto',
    persona: 'Organized, pragmatic, and transparent about blockers.',
    profile: {
      soul: 'Help teams ship deliberately with a clear record of risk.',
      instructions:
        'Collect readiness evidence and never mark a check complete without proof.',
    },
    sources: ['gantry-core-tools'],
    capabilities: ['Read conversation history'],
    skills: [],
    mcpServers: [],
    conversations: [],
    lastRun: 'Never',
    runsToday: 0,
  },
];

export const sources: SourcePreview[] = [
  {
    id: 'gantry-core-tools',
    name: 'Gantry core tools',
    kind: 'Built-in tools',
    description:
      'Reviewed messaging, questions, files, progress, and continuity tools.',
    version: 'Runtime managed',
    status: 'ready',
    selectedBy: 4,
    capabilities: [
      'Send messages',
      'Ask questions',
      'Create files',
      'Track progress',
    ],
  },
  {
    id: 'support-playbook',
    name: 'Support playbook',
    kind: 'Skill catalog',
    description:
      'Reviewed support classification and customer-response procedures.',
    version: 'v3',
    status: 'ready',
    selectedBy: 1,
    capabilities: ['Support triage', 'Incident summary'],
  },
  {
    id: 'research-library',
    name: 'Research library',
    kind: 'MCP server',
    description: 'Reviewed access to the internal knowledge library.',
    version: 'v7',
    status: 'ready',
    selectedBy: 1,
    capabilities: ['Search knowledge base', 'Read source document'],
  },
  {
    id: 'browser-catalog',
    name: 'Browser',
    kind: 'Built-in tools',
    description:
      'Gantry-owned browser capability with reviewed network policy.',
    version: 'Runtime managed',
    status: 'attention',
    selectedBy: 1,
    capabilities: ['Browser'],
    blocker: 'Live readiness requires a connected runtime check.',
  },
  {
    id: 'reporting-cli',
    name: 'Reporting CLI',
    kind: 'Local CLI',
    description:
      'Reviewed command templates for operational report generation.',
    version: 'v1.8',
    status: 'blocked',
    selectedBy: 1,
    capabilities: ['Generate report', 'Validate workbook'],
    blocker:
      'Executable identity could not be verified in the preview snapshot.',
  },
];

export const modelAliases = [
  { value: 'sonnet', label: 'Sonnet', family: 'Anthropic' },
  { value: 'opus', label: 'Opus', family: 'Anthropic' },
  { value: 'gpt-5', label: 'GPT-5', family: 'OpenAI' },
] as const;

export const allCapabilities = [
  'Send messages',
  'Read conversation history',
  'Create files',
  'Browser',
  'Search knowledge base',
  'Generate report',
] as const;
