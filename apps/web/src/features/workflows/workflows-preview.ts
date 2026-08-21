export type WorkflowStepType =
  | 'agent'
  | 'approval'
  | 'external'
  | 'notification';

export type WorkflowStepPreview = {
  id: string;
  name: string;
  type: WorkflowStepType;
  description: string;
  capability?: string;
  externalSystem?: string;
  notificationRoute?: string;
};

export type WorkflowVersionPreview = {
  version: number;
  createdAt: string;
  createdBy: string;
  summary: string;
  steps: WorkflowStepPreview[];
};

export type WorkflowPreview = {
  id: string;
  name: string;
  description: string;
  owner: string;
  status: 'enabled' | 'disabled' | 'draft';
  trigger: string;
  currentVersion: number;
  versions: WorkflowVersionPreview[];
  recentRunIds: string[];
};

export type WorkflowRunPreview = {
  id: string;
  workflowId: string;
  version: number;
  status: 'completed' | 'running' | 'waiting' | 'failed';
  startedAt: string;
  duration: string;
  outcome: string;
  steps: {
    id: string;
    name: string;
    status: 'completed' | 'running' | 'waiting' | 'failed';
    detail: string;
    time: string;
  }[];
  receipt: {
    used: string;
    changed: string;
    delegated: boolean;
    attention: string;
  };
  files: { name: string; size: string }[];
};

export const workflows: WorkflowPreview[] = [
  {
    id: 'support-escalation',
    name: 'Support escalation',
    description:
      'Triage a high-priority request, gather evidence, request approval, and notify the owner.',
    owner: 'Maya Chen',
    status: 'enabled',
    trigger: 'High-priority support request',
    currentVersion: 3,
    recentRunIds: ['workflow-run-302', 'workflow-run-301'],
    versions: [
      {
        version: 3,
        createdAt: '2 days ago',
        createdBy: 'Maya Chen',
        summary: 'Added explicit owner approval before notification.',
        steps: [
          {
            id: 'step-triage',
            name: 'Triage request',
            type: 'agent',
            description:
              'Support triage gathers evidence and classifies urgency.',
            capability: 'Read conversation history',
          },
          {
            id: 'step-approval',
            name: 'Owner approval',
            type: 'approval',
            description: 'Pause for an owner decision before escalation.',
          },
          {
            id: 'step-notify',
            name: 'Notify owner',
            type: 'notification',
            description: 'Send the approved outcome to the support channel.',
            notificationRoute: '#product-support',
          },
        ],
      },
      {
        version: 2,
        createdAt: '3 weeks ago',
        createdBy: 'Maya Chen',
        summary: 'Changed notification route to #product-support.',
        steps: [
          {
            id: 'step-triage-v2',
            name: 'Triage request',
            type: 'agent',
            description: 'Gather evidence and classify urgency.',
            capability: 'Read conversation history',
          },
          {
            id: 'step-notify-v2',
            name: 'Notify owner',
            type: 'notification',
            description: 'Send outcome.',
            notificationRoute: '#product-support',
          },
        ],
      },
    ],
  },
  {
    id: 'vendor-review',
    name: 'Vendor review',
    description:
      'Collect vendor changes, compare evidence, and wait for an external procurement check.',
    owner: 'Aria Kapoor',
    status: 'enabled',
    trigger: 'Weekday schedule at 07:30',
    currentVersion: 2,
    recentRunIds: ['workflow-run-207'],
    versions: [
      {
        version: 2,
        createdAt: '1 week ago',
        createdBy: 'Aria Kapoor',
        summary: 'Added procurement review step.',
        steps: [
          {
            id: 'vendor-research',
            name: 'Research changes',
            type: 'agent',
            description: 'Review approved vendor sources.',
            capability: 'Browser',
          },
          {
            id: 'procurement-check',
            name: 'Procurement check',
            type: 'external',
            description: 'Wait for procurement review.',
            externalSystem: 'Procurement workspace',
          },
          {
            id: 'vendor-notify',
            name: 'Publish brief',
            type: 'notification',
            description: 'Send final brief.',
            notificationRoute: 'Research room',
          },
        ],
      },
    ],
  },
  {
    id: 'release-readiness',
    name: 'Release readiness',
    description: 'Draft workflow for collecting release evidence and approval.',
    owner: 'Release coordinator',
    status: 'draft',
    trigger: 'Manual',
    currentVersion: 0,
    recentRunIds: [],
    versions: [
      {
        version: 0,
        createdAt: 'Today',
        createdBy: 'Local draft',
        summary: 'Unpublished preview draft.',
        steps: [
          {
            id: 'release-evidence',
            name: 'Collect evidence',
            type: 'agent',
            description: 'Collect release check evidence.',
          },
          {
            id: 'release-approval',
            name: 'Release approval',
            type: 'approval',
            description: 'Wait for release owner approval.',
          },
        ],
      },
    ],
  },
];

export const workflowRuns: WorkflowRunPreview[] = [
  {
    id: 'workflow-run-302',
    workflowId: 'support-escalation',
    version: 3,
    status: 'completed',
    startedAt: 'Yesterday, 14:21',
    duration: '3m 18s',
    outcome: 'Escalation approved and delivered to the configured route.',
    steps: [
      {
        id: 'run-step-1',
        name: 'Triage request',
        status: 'completed',
        detail: 'Evidence and urgency summary prepared.',
        time: '14:21',
      },
      {
        id: 'run-step-2',
        name: 'Owner approval',
        status: 'completed',
        detail: 'Maya Chen approved once.',
        time: '14:23',
      },
      {
        id: 'run-step-3',
        name: 'Notify owner',
        status: 'completed',
        detail: 'Outcome delivered to #product-support.',
        time: '14:24',
      },
    ],
    receipt: {
      used: 'Support triage, conversation history',
      changed: 'Escalation summary artifact',
      delegated: false,
      attention: 'None',
    },
    files: [{ name: 'escalation-summary-284.md', size: '12 KB' }],
  },
  {
    id: 'workflow-run-301',
    workflowId: 'support-escalation',
    version: 3,
    status: 'failed',
    startedAt: '3 days ago',
    duration: '18s',
    outcome:
      'Notification step failed because the provider connection was offline.',
    steps: [
      {
        id: 'run-old-1',
        name: 'Triage request',
        status: 'completed',
        detail: 'Evidence prepared.',
        time: '09:11',
      },
      {
        id: 'run-old-2',
        name: 'Owner approval',
        status: 'completed',
        detail: 'Approved once.',
        time: '09:12',
      },
      {
        id: 'run-old-3',
        name: 'Notify owner',
        status: 'failed',
        detail: 'Provider connection offline.',
        time: '09:12',
      },
    ],
    receipt: {
      used: 'Support triage',
      changed: 'Draft summary only',
      delegated: false,
      attention: 'Reconnect provider',
    },
    files: [],
  },
  {
    id: 'workflow-run-207',
    workflowId: 'vendor-review',
    version: 2,
    status: 'waiting',
    startedAt: 'Today, 07:30',
    duration: '41m',
    outcome: 'Waiting for procurement review.',
    steps: [
      {
        id: 'vendor-run-1',
        name: 'Research changes',
        status: 'completed',
        detail: '9 sources reviewed.',
        time: '07:30',
      },
      {
        id: 'vendor-run-2',
        name: 'Procurement check',
        status: 'waiting',
        detail: 'External owner response required.',
        time: '07:48',
      },
      {
        id: 'vendor-run-3',
        name: 'Publish brief',
        status: 'waiting',
        detail: 'Blocked by preceding step.',
        time: 'Pending',
      },
    ],
    receipt: {
      used: 'Browser, Research brief skill',
      changed: 'Draft brief',
      delegated: false,
      attention: 'Procurement response required',
    },
    files: [{ name: 'vendor-review-draft.md', size: '24 KB' }],
  },
];

export const externalSystems = [
  {
    id: 'procurement',
    name: 'Procurement workspace',
    status: 'attention',
    pendingSteps: 1,
    detail: 'One workflow waits for an external owner response.',
    action: 'Review external step',
  },
  {
    id: 'slack',
    name: 'Acme Slack',
    status: 'ready',
    pendingSteps: 0,
    detail: 'Notification route readiness represented as healthy.',
    action: 'Review provider',
  },
  {
    id: 'teams',
    name: 'Company Teams',
    status: 'blocked',
    pendingSteps: 0,
    detail: 'Provider connection is offline.',
    action: 'Reconnect provider',
  },
] as const;
