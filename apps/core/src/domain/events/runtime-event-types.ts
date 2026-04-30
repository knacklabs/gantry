export const RUNTIME_EVENT_TYPES = {
  SESSION_MESSAGE_ACCEPTED: 'session.message.accepted',
  SESSION_MESSAGE_INBOUND: 'session.message.inbound',
  SESSION_MESSAGE_OUTBOUND: 'session.message.outbound',
  SESSION_MESSAGE_STREAMING: 'session.message.streaming',
  SESSION_TYPING: 'session.typing',
  SESSION_PROGRESS: 'session.progress',
  JOB_TRIGGERED: 'job.triggered',
  JOB_RUN_STARTED: 'job.run.started',
  JOB_STARTED: 'job.started',
  JOB_STREAMING: 'job.streaming',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_RUN_COMPLETED: 'job.run.completed',
  JOB_RUN_FAILED: 'job.run.failed',
  RUN_STARTED: 'run.started',
  RUN_CANCELED: 'run.canceled',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_TIMEOUT: 'run.timeout',
  RUN_DEAD_LETTERED: 'run.dead_lettered',
  WEBHOOK_TEST: 'webhook.test',
} as const;

export type RuntimeEventType =
  (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES];
