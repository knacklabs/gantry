import type { ExecutionProviderId } from './sessions/sessions.js';

export type JobScheduleType = 'manual' | 'cron' | 'interval' | 'once';

export type JobStatus =
  'active' | 'paused' | 'running' | 'completed' | 'dead_lettered';

export interface JobExecutionContext {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
  sessionId?: string | null;
}

export interface JobNotificationRoute {
  conversationJid: string;
  threadId: string | null;
  providerAccountId?: string | null;
  label: string;
}

export type JobCapabilityRequirementImplementationKind =
  'configured_access' | 'local_cli' | 'mcp_server' | 'builtin_tool';

export interface JobCapabilityRequirementImplementation {
  kind: JobCapabilityRequirementImplementationKind;
  name?: string;
  executablePath?: string;
  executableVersion?: string;
  executableHash?: string;
  commandTemplate?: string;
  authPreflight?: string;
  protectedPaths?: string[];
  networkHosts?: string[];
}

export interface JobCapabilityRequirement {
  capabilityId: string;
  reason: string;
  implementation?: JobCapabilityRequirementImplementation;
}

export type JobAccessRequirementTarget =
  | { kind: 'tool_rule'; rule: string }
  | {
      kind: 'capability';
      capabilityId: string;
      implementation?: JobCapabilityRequirementImplementation;
    }
  | { kind: 'mcp_server'; server: string };

export interface JobAccessRequirement {
  target: JobAccessRequirementTarget;
  reason?: string;
}

export type JobSetupReadinessState =
  | 'ready'
  | 'missing_capability'
  | 'broker_unreachable'
  | 'credential_unknown'
  | 'browser_login_may_be_required'
  | 'mcp_missing_credential';

export interface JobSetupBlocker {
  state: Exclude<JobSetupReadinessState, 'ready'>;
  message: string;
  nextAction: string;
  requirementType:
    | 'tool'
    | 'semantic_capability'
    | 'browser'
    | 'mcp_server'
    | 'credential'
    | 'local_cli';
  requirementId: string;
}

export interface JobSetupState {
  state: JobSetupReadinessState;
  checked_at: string;
  fingerprint: string;
  blockers: JobSetupBlocker[];
  notified_fingerprint?: string | null;
}

export type JobRecoveryIntentKind =
  | 'setup_required'
  | 'missing_capability'
  | 'permission_denied'
  | 'permission_timeout';

export type JobRecoveryIntentState =
  'pending' | 'running' | 'completed' | 'failed' | 'suppressed';

export interface JobRecoveryIntent {
  kind: JobRecoveryIntentKind;
  state: JobRecoveryIntentState;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
  source_run_id?: string | null;
  setup_fingerprint?: string | null;
  requirement_type?: JobSetupBlocker['requirementType'] | null;
  requirement_id?: string | null;
  next_action?: string | null;
  attempts: number;
  last_error?: string | null;
}

export interface Job {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  schedule_type: JobScheduleType;
  schedule_value: string;
  status: JobStatus;
  session_id: string | null;
  thread_id: string | null;
  workspace_key: string;
  created_by: 'agent' | 'human';
  created_at: string;
  updated_at: string;
  next_run: string | null;
  last_run: string | null;
  silent: boolean;
  cleanup_after_ms: number;
  timeout_ms: number;
  max_retries: number;
  retry_backoff_ms: number;
  max_consecutive_failures: number;
  consecutive_failures: number;
  lease_run_id: string | null;
  lease_expires_at: string | null;
  pause_reason: string | null;
  execution_context?: JobExecutionContext;
  notification_routes?: JobNotificationRoute[];
  access_requirements?: JobAccessRequirement[];
  setup_state?: JobSetupState;
  recovery_intent?: JobRecoveryIntent | null;
  required_capabilities?: string[];
}

export type JobRunStatus =
  'running' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';

export interface JobRun {
  run_id: string;
  short_id?: number | null;
  job_id: string;
  execution_provider_id: ExecutionProviderId;
  agent_engine?: import('../shared/agent-engine.js').AgentEngine | null;
  provider_run_id?: string | null;
  provider_session_id?: string | null;
  worker_id?: string | null;
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  scheduled_for: string;
  started_at: string;
  ended_at: string | null;
  status: JobRunStatus;
  result_summary: string | null;
  error_summary: string | null;
  retry_count: number;
  notified_at: string | null;
}

export interface JobEvent {
  id: number;
  job_id: string;
  run_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
}
