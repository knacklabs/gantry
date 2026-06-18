export const RUNTIME_EVENT_TYPES = {
  SESSION_MESSAGE_INBOUND: 'session.message.inbound',
  SESSION_MESSAGE_OUTBOUND: 'session.message.outbound',
  SESSION_MESSAGE_STREAMING: 'session.message.streaming',
  SESSION_TYPING: 'session.typing',
  SESSION_PROGRESS: 'session.progress',
  CONVERSATION_MESSAGE_INBOUND: 'conversation.message.inbound',
  CONVERSATION_MESSAGE_OUTBOUND: 'conversation.message.outbound',
  JOB_TRIGGERED: 'job.triggered',
  JOB_RUN_STARTED: 'job.run.started',
  JOB_STARTED: 'job.started',
  JOB_STREAMING: 'job.streaming',
  JOB_HEARTBEAT: 'job.heartbeat',
  JOB_SETUP_REQUIRED: 'job.setup_required',
  JOB_TOOL_DENIED: 'job.tool_denied',
  JOB_TOOL_ACTIVITY: 'job.tool_activity',
  TASK_STARTED: 'task.started',
  TASK_PROGRESS: 'task.progress',
  TASK_UPDATED: 'task.updated',
  TASK_NOTIFICATION: 'task.notification',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',
  JOB_RUN_COMPLETED: 'job.run.completed',
  JOB_RUN_FAILED: 'job.run.failed',
  PERMISSION_REQUESTED: 'permission.requested',
  PERMISSION_ALLOWED: 'permission.allowed',
  PERMISSION_DENIED: 'permission.denied',
  PERMISSION_CANCELLED: 'permission.cancelled',
  PERMISSION_PERSISTED: 'permission.persisted',
  PERMISSION_RESUMED: 'permission.resumed',
  PERMISSION_FINAL_OUTCOME: 'permission.final_outcome',
  PERMISSION_YOLO_DENYLIST_HIT: 'permission.yolo_denylist_hit',
  CREDENTIAL_CAPABILITY_UPDATED: 'credential.capability.updated',
  CREDENTIAL_CAPABILITY_REMOVED: 'credential.capability.removed',
  CREDENTIAL_MODEL_UPDATED: 'credential.model.updated',
  CREDENTIAL_MODEL_DISABLED: 'credential.model.disabled',
  CREDENTIAL_MODEL_USED: 'credential.model.used',
  PROFILE_FILE_READ: 'profile.file.read',
  PROFILE_FILE_UPDATED: 'profile.file.updated',
  EGRESS_CONNECT: 'egress.connect',
  MCP_TOOL_ACTIVITY: 'mcp.tool_activity',
  SANDBOX_BLOCKED: 'sandbox.blocked',
  RUN_STARTED: 'run.started',
  RUN_STARTUP_DIAGNOSTIC: 'run.startup_diagnostic',
  RUN_FAILOVER: 'run.failover',
  RUN_CANCELED: 'run.canceled',
  RUN_COMPLETED: 'run.completed',
  RUN_FAILED: 'run.failed',
  RUN_TIMEOUT: 'run.timeout',
  RUN_DEAD_LETTERED: 'run.dead_lettered',
  WEBHOOK_TEST: 'webhook.test',
} as const;

export type RuntimeEventType =
  (typeof RUNTIME_EVENT_TYPES)[keyof typeof RUNTIME_EVENT_TYPES];

const RUNTIME_EVENT_TYPE_VALUES = new Set<string>(
  Object.values(RUNTIME_EVENT_TYPES),
);

const RUNTIME_EVENT_TYPE_ALIASES: Record<string, RuntimeEventType> = {
  job_finished: RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED,
  'job.finished': RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED,
  job_failed: RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
  'job.failed_run': RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
  job_dead_lettered: RUNTIME_EVENT_TYPES.RUN_DEAD_LETTERED,
  'job.dead_lettered': RUNTIME_EVENT_TYPES.RUN_DEAD_LETTERED,
  run_completed: RUNTIME_EVENT_TYPES.RUN_COMPLETED,
  run_failed: RUNTIME_EVENT_TYPES.RUN_FAILED,
  run_timeout: RUNTIME_EVENT_TYPES.RUN_TIMEOUT,
  run_dead_lettered: RUNTIME_EVENT_TYPES.RUN_DEAD_LETTERED,
};

export function isRuntimeEventType(value: unknown): value is RuntimeEventType {
  return (
    typeof value === 'string' &&
    RUNTIME_EVENT_TYPE_VALUES.has(value as RuntimeEventType)
  );
}

export function parseRuntimeEventType(
  value: unknown,
): RuntimeEventType | undefined {
  if (isRuntimeEventType(value)) return value;
  if (typeof value !== 'string') return undefined;
  return RUNTIME_EVENT_TYPE_ALIASES[value.trim()];
}

export function requireRuntimeEventType(
  value: unknown,
  context = 'Runtime event type',
): RuntimeEventType {
  if (isRuntimeEventType(value)) return value;
  throw new Error(`${context} must be a known runtime event type.`);
}
