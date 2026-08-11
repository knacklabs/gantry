export type StatusTone = 'neutral' | 'success' | 'attention' | 'danger';

export type ProviderPreview = {
  id: string;
  name: string;
  kind: string;
  account: string;
  conversations: number;
  discoveredAt: string;
  status: 'ready' | 'attention' | 'offline';
  detail: string;
};

export type ConversationPreview = {
  id: string;
  name: string;
  provider: string;
  kind: string;
  agent: string;
  policy: string;
  members: number;
  activity: string;
  status: 'active' | 'quiet' | 'blocked';
};

export type InteractionPreview = {
  id: string;
  kind: 'approval' | 'question';
  title: string;
  description: string;
  agent: string;
  conversation: string;
  requestedAt: string;
  risk: 'low' | 'medium' | 'high';
  choices: string[];
};

export type DiagnosticPreview = {
  id: string;
  check: string;
  area: string;
  summary: string;
  detail: string;
  checkedAt: string;
  status: 'passing' | 'warning' | 'failing';
};

export const overviewMetrics = [
  { label: 'Conversations', value: '12', detail: '5 active today' },
  { label: 'Agents', value: '4', detail: '3 deployed' },
  { label: 'Runs · 24h', value: '142', detail: '2 streaming' },
  { label: 'Cost today', value: '$12.40', detail: 'of $50 budget' },
] as const;

export const setupBlockers = [
  {
    id: 'openrouter-key',
    title: 'OpenRouter credential is missing',
    detail:
      'Model routes using OpenRouter cannot start until a credential is configured.',
    action: 'Review provider',
  },
  {
    id: 'ops-alerts-agent',
    title: '#ops-alerts has no assigned agent',
    detail:
      'Messages can be discovered, but Gantry has no agent to handle them.',
    action: 'Open conversation',
  },
] as const;

export const providers: ProviderPreview[] = [
  {
    id: 'slack-acme',
    name: 'Acme Slack',
    kind: 'Slack',
    account: 'acme-workspace',
    conversations: 8,
    discoveredAt: '2 min ago',
    status: 'ready',
    detail:
      'Socket connection healthy. Events and replies are arriving normally.',
  },
  {
    id: 'telegram-personal',
    name: 'Personal Telegram',
    kind: 'Telegram',
    account: '@gantry_helper_bot',
    conversations: 3,
    discoveredAt: '8 min ago',
    status: 'ready',
    detail: 'Long polling is current and the bot identity is verified.',
  },
  {
    id: 'openrouter-primary',
    name: 'OpenRouter',
    kind: 'Model provider',
    account: 'Primary models',
    conversations: 0,
    discoveredAt: 'Not checked',
    status: 'attention',
    detail:
      'Credential readiness cannot be confirmed in this disconnected preview.',
  },
  {
    id: 'teams-company',
    name: 'Company Teams',
    kind: 'Microsoft Teams',
    account: 'Contoso tenant',
    conversations: 1,
    discoveredAt: 'Yesterday',
    status: 'offline',
    detail:
      'The preview shows an expired connection that needs owner attention.',
  },
];

export const conversations: ConversationPreview[] = [
  {
    id: 'ops-alerts',
    name: '#ops-alerts',
    provider: 'Acme Slack',
    kind: 'Channel',
    agent: 'Not assigned',
    policy: 'Members can message',
    members: 34,
    activity: '4 min ago',
    status: 'blocked',
  },
  {
    id: 'product-support',
    name: '#product-support',
    provider: 'Acme Slack',
    kind: 'Channel',
    agent: 'Support triage',
    policy: 'Mention required',
    members: 86,
    activity: '11 min ago',
    status: 'active',
  },
  {
    id: 'research-room',
    name: 'Research room',
    provider: 'Personal Telegram',
    kind: 'Group',
    agent: 'Research assistant',
    policy: 'Approved senders',
    members: 7,
    activity: '43 min ago',
    status: 'active',
  },
  {
    id: 'finance-review',
    name: 'Finance review',
    provider: 'Company Teams',
    kind: 'Channel',
    agent: 'Operations analyst',
    policy: 'Mention required',
    members: 18,
    activity: 'Yesterday',
    status: 'quiet',
  },
  {
    id: 'personal-notes',
    name: 'Personal notes',
    provider: 'Personal Telegram',
    kind: 'Direct message',
    agent: 'Research assistant',
    policy: 'Owner only',
    members: 1,
    activity: '2 days ago',
    status: 'quiet',
  },
];

export const interactions: InteractionPreview[] = [
  {
    id: 'approve-export',
    kind: 'approval',
    title: 'Export the weekly support report',
    description:
      'Support triage wants to create a CSV in the shared reports folder.',
    agent: 'Support triage',
    conversation: '#product-support',
    requestedAt: '3 min ago',
    risk: 'medium',
    choices: ['Allow once', 'Allow for future', 'Cancel'],
  },
  {
    id: 'approve-browser',
    kind: 'approval',
    title: 'Use Browser for vendor research',
    description:
      'Research assistant needs reviewed browser access for this run.',
    agent: 'Research assistant',
    conversation: 'Research room',
    requestedAt: '18 min ago',
    risk: 'high',
    choices: ['Allow once', 'Cancel'],
  },
  {
    id: 'question-region',
    kind: 'question',
    title: 'Which reporting region should be used?',
    description:
      'The scheduled analysis needs one region before it can continue.',
    agent: 'Operations analyst',
    conversation: 'Finance review',
    requestedAt: '1 hr ago',
    risk: 'low',
    choices: ['North America', 'Europe', 'Asia Pacific'],
  },
];

export const diagnostics: DiagnosticPreview[] = [
  {
    id: 'runtime',
    check: 'Runtime process',
    area: 'Host',
    summary: 'Runtime is responding',
    detail: 'The most recent preview health result completed in 42 ms.',
    checkedAt: '1 min ago',
    status: 'passing',
  },
  {
    id: 'database',
    check: 'Postgres projection',
    area: 'Storage',
    summary: 'Schema and revision are current',
    detail: 'No unapplied migration is represented in this preview snapshot.',
    checkedAt: '1 min ago',
    status: 'passing',
  },
  {
    id: 'model-credentials',
    check: 'Model credentials',
    area: 'Providers',
    summary: 'One credential needs attention',
    detail:
      'OpenRouter readiness is unknown. Secret values are never shown here.',
    checkedAt: '2 min ago',
    status: 'warning',
  },
  {
    id: 'teams-connection',
    check: 'Teams connection',
    area: 'Providers',
    summary: 'Connection is offline',
    detail:
      'Reconnect the Company Teams provider before expecting new messages.',
    checkedAt: 'Yesterday',
    status: 'failing',
  },
];
