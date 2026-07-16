export type JobStatus = 'enabled' | 'paused' | 'blocked';
export type RunStatus = 'completed' | 'failed' | 'running' | 'waiting';

export type JobPreview = {
  id: string;
  name: string;
  description: string;
  agent: string;
  status: JobStatus;
  schedule: string;
  nextRun: string;
  notificationRoutes: string[];
  recentRunIds: string[];
  blocker?: { summary: string; action: string };
};

export type RunPreview = {
  id: string;
  jobId: string;
  status: RunStatus;
  startedAt: string;
  duration: string;
  outcome: string;
  timeline: {
    label: string;
    detail: string;
    time: string;
    status: 'done' | 'active' | 'failed';
  }[];
  files: { name: string; size: string }[];
  receipt: {
    used: string;
    changed: string;
    delegated: boolean;
    attention: string;
  };
  blocker?: { summary: string; action: string };
};

export const jobs: JobPreview[] = [
  {
    id: 'weekly-support-review',
    name: 'Weekly support review',
    description:
      'Summarize support volume, urgent cases, and owner follow-ups.',
    agent: 'Support triage',
    status: 'enabled',
    schedule: 'Mondays at 08:00',
    nextRun: 'In 3 days',
    notificationRoutes: ['#product-support'],
    recentRunIds: ['run-support-142', 'run-support-141'],
  },
  {
    id: 'vendor-watch',
    name: 'Vendor watch',
    description:
      'Review product and pricing changes from the approved vendor list.',
    agent: 'Research assistant',
    status: 'enabled',
    schedule: 'Weekdays at 07:30',
    nextRun: 'Tomorrow',
    notificationRoutes: ['Research room'],
    recentRunIds: ['run-vendor-88'],
  },
  {
    id: 'regional-operations',
    name: 'Regional operations digest',
    description: 'Build the regional performance summary and flag exceptions.',
    agent: 'Operations analyst',
    status: 'blocked',
    schedule: 'Fridays at 06:00',
    nextRun: 'Blocked',
    notificationRoutes: ['Finance review'],
    recentRunIds: ['run-regional-37'],
    blocker: {
      summary: 'Reporting CLI executable identity needs review.',
      action: 'Review Reporting CLI',
    },
  },
  {
    id: 'release-readiness',
    name: 'Release readiness review',
    description: 'Collect release evidence and summarize unresolved checks.',
    agent: 'Release coordinator',
    status: 'paused',
    schedule: 'Manual only',
    nextRun: 'Paused',
    notificationRoutes: [],
    recentRunIds: [],
  },
];

export const runs: RunPreview[] = [
  {
    id: 'run-support-142',
    jobId: 'weekly-support-review',
    status: 'completed',
    startedAt: 'Monday, 08:00',
    duration: '2m 14s',
    outcome: 'Weekly support review delivered with three owner follow-ups.',
    timeline: [
      {
        label: 'Run claimed',
        detail: 'Worker accepted the scheduled run.',
        time: '08:00:01',
        status: 'done',
      },
      {
        label: 'Evidence gathered',
        detail: 'Reviewed 42 support requests.',
        time: '08:01:08',
        status: 'done',
      },
      {
        label: 'Outcome delivered',
        detail: 'Notification sent to the configured route.',
        time: '08:02:15',
        status: 'done',
      },
    ],
    files: [{ name: 'support-review-week-28.csv', size: '84 KB' }],
    receipt: {
      used: 'Conversation history, Support triage skill',
      changed: 'Generated report artifact',
      delegated: false,
      attention: 'Three follow-ups remain open',
    },
  },
  {
    id: 'run-support-141',
    jobId: 'weekly-support-review',
    status: 'completed',
    startedAt: 'Last Monday, 08:00',
    duration: '1m 58s',
    outcome: 'Weekly support review delivered.',
    timeline: [
      {
        label: 'Run claimed',
        detail: 'Worker accepted the scheduled run.',
        time: '08:00:01',
        status: 'done',
      },
      {
        label: 'Outcome delivered',
        detail: 'Notification sent.',
        time: '08:01:59',
        status: 'done',
      },
    ],
    files: [],
    receipt: {
      used: 'Conversation history',
      changed: 'None',
      delegated: false,
      attention: 'None',
    },
  },
  {
    id: 'run-vendor-88',
    jobId: 'vendor-watch',
    status: 'running',
    startedAt: 'Today, 07:30',
    duration: '18m',
    outcome: 'Reviewing final source provenance.',
    timeline: [
      {
        label: 'Run claimed',
        detail: 'Worker accepted the scheduled run.',
        time: '07:30:02',
        status: 'done',
      },
      {
        label: 'Vendor changes reviewed',
        detail: '7 of 9 sources complete.',
        time: '07:44:19',
        status: 'active',
      },
    ],
    files: [],
    receipt: {
      used: 'Browser, Research brief skill',
      changed: 'Draft only',
      delegated: false,
      attention: 'Run in progress',
    },
  },
  {
    id: 'run-regional-37',
    jobId: 'regional-operations',
    status: 'failed',
    startedAt: 'Last Friday, 06:00',
    duration: '4s',
    outcome:
      'Run stopped before execution because a required capability was unavailable.',
    timeline: [
      {
        label: 'Preflight failed',
        detail: 'Reporting CLI executable identity could not be verified.',
        time: '06:00:04',
        status: 'failed',
      },
    ],
    files: [],
    receipt: {
      used: 'Capability preflight',
      changed: 'None',
      delegated: false,
      attention: 'Review Reporting CLI',
    },
    blocker: {
      summary: 'Reporting CLI executable identity needs review.',
      action: 'Review Reporting CLI',
    },
  },
];
