export type ModelPreview = {
  alias: string;
  family: string;
  compatibleHarnesses: string[];
  readiness: 'ready' | 'attention';
  requests24h: number;
  tokens24h: string;
  cost24h: string;
};

export type ActivityPreview = {
  id: string;
  time: string;
  type: 'agent' | 'job' | 'permission' | 'provider' | 'settings';
  actor: string;
  resource: string;
  summary: string;
  detail: string;
  outcome: 'success' | 'attention' | 'failed';
};

export const models: ModelPreview[] = [
  {
    alias: 'sonnet',
    family: 'Anthropic',
    compatibleHarnesses: ['auto', 'anthropic_sdk'],
    readiness: 'ready',
    requests24h: 92,
    tokens24h: '1.8M',
    cost24h: '$8.42',
  },
  {
    alias: 'opus',
    family: 'Anthropic',
    compatibleHarnesses: ['auto', 'anthropic_sdk'],
    readiness: 'ready',
    requests24h: 31,
    tokens24h: '840K',
    cost24h: '$3.76',
  },
  {
    alias: 'gpt-5',
    family: 'OpenAI',
    compatibleHarnesses: ['auto', 'deepagents'],
    readiness: 'ready',
    requests24h: 19,
    tokens24h: '310K',
    cost24h: '$0.22',
  },
  {
    alias: 'openrouter-reasoning',
    family: 'OpenRouter',
    compatibleHarnesses: ['auto', 'deepagents'],
    readiness: 'attention',
    requests24h: 0,
    tokens24h: '0',
    cost24h: '$0.00',
  },
];

export const memoryStores = [
  {
    name: 'Conversation continuity',
    records: '1,284',
    status: 'ready',
    detail: 'Session digests and continuity summaries',
  },
  {
    name: 'Remembered information',
    records: '86',
    status: 'ready',
    detail: 'Owner-visible facts with provenance',
  },
  {
    name: 'Review queue',
    records: '4',
    status: 'attention',
    detail: 'Contradictions and low-confidence memories',
  },
] as const;

export const memoryPipeline = [
  {
    label: 'Capture',
    detail: 'Eligible owner-visible statements',
    status: 'ready',
  },
  {
    label: 'Normalize',
    detail: 'Identity and provenance linked',
    status: 'ready',
  },
  {
    label: 'Review',
    detail: '4 records need owner review',
    status: 'attention',
  },
  {
    label: 'Retention',
    detail: 'Policy represented without raw content',
    status: 'ready',
  },
] as const;

export const capacity = {
  activeRuns: 2,
  queueDepth: 5,
  concurrencyUsed: 3,
  concurrencyLimit: 8,
  budgetUsed: 12.4,
  budgetLimit: 50,
  queue: [
    {
      id: 'queue-1',
      work: 'Vendor watch',
      agent: 'Research assistant',
      wait: 'Running',
      status: 'running',
    },
    {
      id: 'queue-2',
      work: 'Support follow-up',
      agent: 'Support triage',
      wait: '12s',
      status: 'queued',
    },
    {
      id: 'queue-3',
      work: 'Memory review',
      agent: 'Research assistant',
      wait: '31s',
      status: 'queued',
    },
    {
      id: 'queue-4',
      work: 'Conversation turn',
      agent: 'Support triage',
      wait: '44s',
      status: 'queued',
    },
    {
      id: 'queue-5',
      work: 'Activity digest',
      agent: 'Operations analyst',
      wait: 'Blocked',
      status: 'blocked',
    },
  ],
} as const;

export const guardrails = [
  {
    id: 'sandbox',
    name: 'Execution sandbox',
    status: 'ready',
    summary:
      'Protected paths and process boundaries are represented as active.',
    detail:
      'Exact sandbox rules and host paths are redacted from browser previews.',
  },
  {
    id: 'egress',
    name: 'Outbound egress',
    status: 'ready',
    summary: 'Approved tool traffic uses the Gantry egress boundary.',
    detail: 'Broker addresses, tokens, and decision rules are redacted.',
  },
  {
    id: 'permissions',
    name: 'Permission evaluation',
    status: 'ready',
    summary: 'Risky actions require deterministic policy and owner approval.',
    detail: 'No raw permission grants or transient tokens are exposed.',
  },
  {
    id: 'denylist',
    name: 'Auto-approval denylist',
    status: 'attention',
    summary: 'Two recent actions returned to explicit owner approval.',
    detail:
      'Matched rules are redacted; owner-visible outcomes remain available in activity.',
  },
] as const;

export const activities: ActivityPreview[] = [
  {
    id: 'evt-1018',
    time: '2 min ago',
    type: 'agent',
    actor: 'Support triage',
    resource: '#product-support',
    summary: 'Completed a conversation turn',
    detail: 'Final answer delivered with evidence receipt.',
    outcome: 'success',
  },
  {
    id: 'evt-1017',
    time: '3 min ago',
    type: 'permission',
    actor: 'Maya Chen',
    resource: 'Weekly support review',
    summary: 'Approval remains pending',
    detail: 'Export report is waiting for an owner decision.',
    outcome: 'attention',
  },
  {
    id: 'evt-1016',
    time: '11 min ago',
    type: 'job',
    actor: 'Worker workstation-01',
    resource: 'Vendor watch',
    summary: 'Scheduled run claimed',
    detail: 'Lease and token details are redacted.',
    outcome: 'success',
  },
  {
    id: 'evt-1015',
    time: '18 min ago',
    type: 'provider',
    actor: 'Acme Slack',
    resource: 'Provider connection',
    summary: 'Conversation discovery completed',
    detail: '8 allowed conversations represented.',
    outcome: 'success',
  },
  {
    id: 'evt-1014',
    time: '43 min ago',
    type: 'agent',
    actor: 'Research assistant',
    resource: 'Vendor research brief',
    summary: 'Source review completed',
    detail: 'Three primary sources and two vendor documents reviewed.',
    outcome: 'success',
  },
  {
    id: 'evt-1013',
    time: '1 hr ago',
    type: 'job',
    actor: 'Scheduler',
    resource: 'Regional operations digest',
    summary: 'Run blocked during preflight',
    detail: 'Reporting CLI executable identity needs review.',
    outcome: 'failed',
  },
  {
    id: 'evt-1012',
    time: '2 hrs ago',
    type: 'settings',
    actor: 'Local owner',
    resource: 'Support triage',
    summary: 'Desired-state draft reviewed',
    detail: 'No browser write occurred; this is preview evidence.',
    outcome: 'attention',
  },
  {
    id: 'evt-1011',
    time: 'Yesterday',
    type: 'permission',
    actor: 'Jon Bell',
    resource: 'Incident 284',
    summary: 'One-time file write approved',
    detail: 'Grant scope and transient token are redacted.',
    outcome: 'success',
  },
  {
    id: 'evt-1010',
    time: 'Yesterday',
    type: 'provider',
    actor: 'Company Teams',
    resource: 'Provider connection',
    summary: 'Connection check failed',
    detail: 'Reconnect the provider before expecting messages.',
    outcome: 'failed',
  },
  {
    id: 'evt-1009',
    time: '2 days ago',
    type: 'agent',
    actor: 'Operations analyst',
    resource: 'Finance review',
    summary: 'Question requested',
    detail: 'Reporting region is required before continuing.',
    outcome: 'attention',
  },
  {
    id: 'evt-1008',
    time: '2 days ago',
    type: 'job',
    actor: 'Scheduler',
    resource: 'Weekly support review',
    summary: 'Terminal notification delivered',
    detail: 'Outcome sent to the configured route.',
    outcome: 'success',
  },
  {
    id: 'evt-1007',
    time: '3 days ago',
    type: 'settings',
    actor: 'Local owner',
    resource: 'Research assistant',
    summary: 'Browser capability selected',
    detail: 'Authority details are redacted from this preview.',
    outcome: 'success',
  },
];
