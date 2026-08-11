export type SessionStatus = 'active' | 'waiting' | 'completed';

export type ChatSessionPreview = {
  id: string;
  title: string;
  agent: string;
  conversation: string;
  status: SessionStatus;
  activity: string;
  preview: string;
  unread: number;
};

export type ChatMessagePreview = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  author: string;
  content: string;
  time: string;
  descriptors?: InteractionPreview[];
};

export type InteractionPreview =
  | {
      kind: 'question';
      title: string;
      prompt: string;
      options: string[];
      disabled?: boolean;
    }
  | {
      kind: 'approval';
      title: string;
      summary: string;
      risk: 'low' | 'medium' | 'high';
      disabled?: boolean;
    }
  | {
      kind: 'todo';
      title: string;
      items: { label: string; status: 'done' | 'active' | 'pending' }[];
    }
  | { kind: 'progress'; label: string; detail: string; value: number }
  | { kind: 'file'; name: string; size: string; mediaType: string }
  | {
      kind: 'receipt';
      outcome: string;
      used: string;
      changed: string;
      delegated: boolean;
      attention: string;
    }
  | { kind: 'fact'; label: string; value: string; provenance: string }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'table'; title: string; columns: string[]; rows: string[][] }
  | {
      kind: 'form';
      title: string;
      fields: { label: string; value: string }[];
      disabled?: boolean;
    }
  | { kind: 'media'; title: string; caption: string; mediaType: string }
  | {
      kind: 'dependency';
      name: string;
      status: 'ready' | 'blocked';
      detail: string;
    };

export type MemoryPreview = {
  id: string;
  category: 'Preference' | 'Identity' | 'Project' | 'Relationship';
  statement: string;
  confidence: 'high' | 'medium' | 'low';
  provenance: string;
  learnedAt: string;
  contradiction?: string;
};

export const sessions: ChatSessionPreview[] = [
  {
    id: 'weekly-support-review',
    title: 'Weekly support review',
    agent: 'Support triage',
    conversation: '#product-support',
    status: 'waiting',
    activity: '3 min ago',
    preview: 'The report is ready, but exporting the CSV needs approval.',
    unread: 1,
  },
  {
    id: 'vendor-research',
    title: 'Vendor research brief',
    agent: 'Research assistant',
    conversation: 'Research room',
    status: 'active',
    activity: '18 min ago',
    preview: 'Comparing the final two vendors and checking source provenance.',
    unread: 0,
  },
  {
    id: 'regional-analysis',
    title: 'Regional operations analysis',
    agent: 'Operations analyst',
    conversation: 'Finance review',
    status: 'waiting',
    activity: '1 hr ago',
    preview: 'Which reporting region should be used for this run?',
    unread: 1,
  },
  {
    id: 'incident-summary',
    title: 'Incident 284 summary',
    agent: 'Support triage',
    conversation: '#product-support',
    status: 'completed',
    activity: 'Yesterday',
    preview: 'Summary delivered with evidence receipt and follow-up owners.',
    unread: 0,
  },
];

export const messagesBySession: Record<string, ChatMessagePreview[]> = {
  'weekly-support-review': [
    {
      id: 'message-1',
      role: 'user',
      author: 'Maya Chen',
      content:
        'Prepare the weekly support review and flag anything that needs an owner decision.',
      time: '9:14 AM',
    },
    {
      id: 'message-2',
      role: 'assistant',
      author: 'Support triage',
      content:
        'I reviewed the support queue and grouped the open work by urgency. The report draft is ready.',
      time: '9:16 AM',
      descriptors: [
        {
          kind: 'todo',
          title: 'Weekly review',
          items: [
            { label: 'Review 42 open requests', status: 'done' },
            { label: 'Group owner follow-ups', status: 'done' },
            { label: 'Export report', status: 'active' },
          ],
        },
        {
          kind: 'file',
          name: 'support-review-week-28.csv',
          size: '84 KB',
          mediaType: 'text/csv',
        },
        {
          kind: 'approval',
          title: 'Export the weekly support report',
          summary: 'Create the CSV in the shared reports folder.',
          risk: 'medium',
        },
      ],
    },
    {
      id: 'message-3',
      role: 'system',
      author: 'Run timeline',
      content: 'The run is paused while waiting for an owner decision.',
      time: '9:16 AM',
      descriptors: [
        {
          kind: 'progress',
          label: 'Run paused',
          detail: '2 of 3 steps complete',
          value: 66,
        },
        {
          kind: 'receipt',
          outcome: 'Prepared the weekly support review',
          used: 'Conversation history, Support triage skill',
          changed: 'Draft file only',
          delegated: false,
          attention: 'Export approval required',
        },
      ],
    },
  ],
  'vendor-research': [
    {
      id: 'research-1',
      role: 'user',
      author: 'You',
      content:
        'Compare the two shortlisted vendors and make the tradeoffs easy to review.',
      time: '8:41 AM',
    },
    {
      id: 'research-2',
      role: 'assistant',
      author: 'Research assistant',
      content:
        'The comparison is structured below. I kept source confidence visible and separated verified facts from open questions.',
      time: '8:48 AM',
      descriptors: [
        {
          kind: 'fact',
          label: 'Coverage',
          value: 'Both vendors support the required regions.',
          provenance: 'Vendor documentation · reviewed today',
        },
        {
          kind: 'list',
          title: 'Open questions',
          items: [
            'Confirm migration support window',
            'Validate audit export retention',
          ],
        },
        {
          kind: 'table',
          title: 'Shortlist comparison',
          columns: ['Area', 'Northstar', 'Aperture'],
          rows: [
            ['Regions', '12', '14'],
            ['Support', '24/5', '24/7'],
            ['Migration', 'Included', 'Quoted separately'],
          ],
        },
        {
          kind: 'media',
          title: 'Architecture overview',
          caption: 'Preview placeholder for reviewed media.',
          mediaType: 'image/png',
        },
        {
          kind: 'dependency',
          name: 'Browser',
          status: 'ready',
          detail: 'Reviewed capability available for this run.',
        },
      ],
    },
  ],
  'regional-analysis': [
    {
      id: 'region-1',
      role: 'assistant',
      author: 'Operations analyst',
      content: 'I need one scope decision before calculating the report.',
      time: '7:52 AM',
      descriptors: [
        {
          kind: 'question',
          title: 'Reporting region',
          prompt: 'Which reporting region should be used?',
          options: ['North America', 'Europe', 'Asia Pacific'],
        },
        {
          kind: 'form',
          title: 'Report context',
          fields: [
            { label: 'Period', value: 'Week 28' },
            { label: 'Currency', value: 'USD' },
          ],
        },
        {
          kind: 'dependency',
          name: 'Reporting CLI',
          status: 'blocked',
          detail: 'Executable identity needs owner review.',
        },
      ],
    },
  ],
  'incident-summary': [
    {
      id: 'incident-1',
      role: 'assistant',
      author: 'Support triage',
      content:
        'Incident 284 is resolved. The summary and owner follow-ups are recorded.',
      time: 'Yesterday',
      descriptors: [
        {
          kind: 'receipt',
          outcome: 'Incident summary delivered',
          used: 'Conversation history, Incident summary skill',
          changed: 'None',
          delegated: false,
          attention: 'None',
        },
      ],
    },
  ],
};

export const memories: MemoryPreview[] = [
  {
    id: 'memory-1',
    category: 'Preference',
    statement: 'Prefers concise operational summaries with evidence links.',
    confidence: 'high',
    provenance: 'Repeated conversation preference',
    learnedAt: '2 weeks ago',
  },
  {
    id: 'memory-2',
    category: 'Identity',
    statement: 'Maya Chen is the primary owner for support operations.',
    confidence: 'high',
    provenance: 'Verified provider identity',
    learnedAt: '1 month ago',
  },
  {
    id: 'memory-3',
    category: 'Project',
    statement:
      'Weekly support reviews use Monday through Sunday reporting periods.',
    confidence: 'medium',
    provenance: 'Weekly support review session',
    learnedAt: '6 days ago',
  },
  {
    id: 'memory-4',
    category: 'Relationship',
    statement: 'Jon Bell can approve support report exports.',
    confidence: 'low',
    provenance: 'One prior approval',
    learnedAt: '3 weeks ago',
    contradiction:
      'Conversation policy currently lists Maya Chen and Jon Bell as approvers; verify scope before relying on this memory.',
  },
];
