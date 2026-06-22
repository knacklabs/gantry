import type { ExecutionProviderId } from './sessions/sessions.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  workspacePath?: string; // Optional path exposed inside the agent workspace.
  readonly?: boolean; // Default: true for safety
}

export type ThinkingMode = 'adaptive' | 'enabled' | 'disabled';
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'max';

export interface ThinkingOverride {
  mode: ThinkingMode;
  effort?: ThinkingEffort;
  budgetTokens?: number;
  display?: 'summarized' | 'omitted';
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface AgentConfig {
  additionalMounts?: AdditionalMount[];
  persona?: import('../shared/agent-persona.js').AgentPersona;
  relationshipMode?: import('../shared/agent-relationship-mode.js').AgentRelationshipMode;
  model?: string; // Optional model alias/full name for this group
  thinking?: ThinkingOverride; // Optional thinking override for this group
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface ConversationRoute {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean;
  conversationKind?: 'dm' | 'channel';
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  provider?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  external_message_id?: string;
  delivery_status?: MessageDeliveryStatus;
  delivered_at?: string;
  delivery_error?: string;
  delivery_retry_tail?: {
    canonicalText: string;
    providerPayload?: unknown;
  };
  attachments?: NewMessageAttachment[];
}

export interface NewMessageAttachment {
  id?: string;
  kind: 'image' | 'file' | 'audio' | 'video' | 'other';
  contentType?: string;
  sizeBytes?: number;
  externalId?: string;
  storageRef?: string;
}

export type JobScheduleType = 'manual' | 'cron' | 'interval' | 'once';

export type JobStatus =
  | 'active'
  | 'paused'
  | 'running'
  | 'completed'
  | 'dead_lettered';

export interface JobExecutionContext {
  conversationJid: string;
  threadId: string | null;
  workspaceKey: string;
  sessionId?: string | null;
}

export interface JobNotificationRoute {
  conversationJid: string;
  threadId: string | null;
  label: string;
}

export type JobCapabilityRequirementImplementationKind =
  | 'configured_access'
  | 'local_cli'
  | 'mcp_server'
  | 'builtin_tool';

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
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'suppressed';

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
  /**
   * Fleet-distributed capability ids the executing worker must advertise to run
   * this job (`skill:<id>`, `toolchain:<manifestHash>`). Resolved at dispatch in
   * fleet mode and stored durably for observability; always empty in workstation
   * mode. Empty/absent ⇒ runnable on any worker.
   */
  required_capabilities?: string[];
}

export type JobRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'dead_lettered';

export interface JobRun {
  run_id: string;
  short_id?: number | null;
  job_id: string;
  execution_provider_id: ExecutionProviderId;
  // Inherited agent engine for this run, derived from execution_provider_id.
  // Read-only diagnostic exposed in job run detail; jobs never select an engine.
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

// --- Channel capability ports ---
export interface PermissionApprovalRequest {
  requestId: string;
  appId?: string;
  agentId?: string;
  responseNonce?: string;
  sourceAgentFolder: string;
  runHandle?: string;
  jobId?: string;
  jobName?: string;
  runId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  targetJid?: string;
  approvalContextJid?: string;
  threadId?: string;
  responseKeyId?: string;
  decisionPolicy?: 'control_allowlist' | 'same_channel';
  toolName: string;
  toolUseID?: string;
  agentID?: string;
  subagentType?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  closestRule?: {
    rule: string;
    reason: string;
  };
  blockedPath?: string;
  toolInput?: Record<string, unknown>;
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  suggestions?: PermissionApprovalUpdate[];
  decisionOptions?: PermissionApprovalDecisionMode[];
  interaction?: InteractionDescriptor;
}

export type PermissionApprovalDecisionMode =
  | 'allow_once'
  | 'allow_persistent_rule'
  | 'allow_timed_grant'
  | 'cancel';

export interface PermissionApprovalRuleValue {
  toolName: string;
  ruleContent?: string;
}

export interface PermissionApprovalUpdate {
  type:
    | 'addRules'
    | 'replaceRules'
    | 'removeRules'
    | 'setMode'
    | 'addDirectories'
    | 'removeDirectories';
  rules?: PermissionApprovalRuleValue[];
  behavior?: 'allow' | 'deny' | 'ask';
  destination?:
    | 'userSettings'
    | 'projectSettings'
    | 'localSettings'
    | 'session'
    | 'cliArg';
  mode?: string;
  directories?: string[];
}

export interface PermissionApprovalDecision {
  approved: boolean;
  mode?: PermissionApprovalDecisionMode;
  decidedBy?: string;
  reason?: string;
  updatedPermissions?: PermissionApprovalUpdate[];
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
  timedGrantExpiresAtMs?: number;
}

export interface UserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface UserQuestionItem {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export interface UserQuestionRequest {
  requestId: string;
  sourceAgentFolder: string;
  appId?: string;
  agentId?: string;
  jobId?: string;
  runId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  targetJid?: string;
  threadId?: string;
  responseKeyId?: string;
  questions: UserQuestionItem[];
  interaction?: InteractionDescriptor;
}

export interface UserQuestionResponse {
  requestId: string;
  answers: Record<string, string | string[]>;
  answeredBy?: string;
}

export type InteractionSeverity =
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'critical';

export type InteractionSelectionMode = 'none' | 'single' | 'multi';

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
  preview?: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface InteractionAction {
  id: string;
  label: string;
  kind: 'submit' | 'approve' | 'deny' | 'cancel' | 'open' | 'secondary';
  style?: 'primary' | 'danger' | 'default';
  value?: Record<string, unknown>;
}

export interface InteractionDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface InteractionFile {
  path: string;
  sizeBytes?: number;
  contentHash?: string;
  contentType?: string;
  preview?: string;
  truncated?: boolean;
}

export interface InteractionDependency {
  ecosystem: 'npm' | 'brew' | 'go' | 'uv' | 'download' | string;
  name: string;
  version?: string;
  commandArgv?: string[];
  risk?: InteractionSeverity;
}

export interface InteractionAuditSummary {
  actor?: string;
  action: string;
  at?: string;
  reason?: string;
}

export interface InteractionResult {
  status:
    | 'pending'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'failed'
    | 'completed';
  message?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface InteractionDescriptor {
  id: string;
  title: string;
  body?: string;
  severity?: InteractionSeverity;
  requestContext?: {
    requestId?: string;
    sourceAgentFolder?: string;
    targetJid?: string;
    threadId?: string;
    toolName?: string;
    capabilityType?: string;
    capabilityId?: string;
    capabilityDisplayName?: string;
  };
  options?: InteractionOption[];
  selectionMode?: InteractionSelectionMode;
  actions?: InteractionAction[];
  details?: InteractionDetail[];
  files?: InteractionFile[];
  dependencies?: InteractionDependency[];
  auditSummary?: InteractionAuditSummary[];
  result?: InteractionResult;
}

export interface StreamingChunkOptions {
  threadId?: string;
  done?: boolean;
  generation?: number;
}

export interface ProgressUpdateOptions {
  threadId?: string;
  done?: boolean;
  replaceOnly?: boolean;
  generation?: number;
  actionAffordances?: MessageActionAffordance[];
}

export type MessageActionAffordanceKind =
  | 'scheduler_run_now'
  | 'scheduler_pause_job'
  | 'scheduler_open'
  | 'live_turn_stop';

export type MessageActionAffordance =
  | {
      kind: 'scheduler_run_now' | 'scheduler_pause_job' | 'scheduler_open';
      label: string;
      jobId: string;
      runId?: string | null;
    }
  | {
      kind: 'live_turn_stop';
      label: string;
      actionToken: string;
    };

export interface MessageActionCallbackInput {
  kind: 'live_turn_stop';
  conversationJid: string;
  threadId?: string;
  userId?: string;
  actionToken?: string;
}

export type OnMessageAction = (
  input: MessageActionCallbackInput,
) => Promise<void>;

export interface MessageSendOptions {
  threadId?: string;
  actionAffordances?: MessageActionAffordance[];
}

export type MessageDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'partially_sent';

export interface MessageDeliveryResult {
  externalMessageId?: string;
  externalMessageIds?: string[];
  deliveredParts?: number;
  totalParts?: number;
  warnings?: string[];
  fallbackArtifactId?: string;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (
  conversationJid: string,
  message: NewMessage,
) => Promise<void>;

// Callback for chat metadata discovery.
// name is optional for providers that deliver names inline; channels that sync
// names separately omit it.
export type OnChatMetadata = (
  conversationJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => Promise<void>;

export interface ChannelLifecyclePort {
  name: string;
  connect(options?: {
    inbound?: boolean;
    interactionCallbacks?: boolean;
  }): Promise<void>;
  isConnected(): boolean;
  disconnect(): Promise<void>;
}

export interface ChannelOwnershipPort {
  name: string;
  ownsJid(jid: string): boolean;
}

export interface MessageSink {
  name: string;
  sendMessage(
    jid: string,
    text: string,
    options?: MessageSendOptions,
  ): Promise<void | MessageDeliveryResult>;
}

export interface TypingSink {
  setTyping(jid: string, isTyping: boolean): Promise<void>;
}

export interface StreamingSink {
  sendStreamingChunk(
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ): Promise<boolean>;
}

export interface StreamingStateSink {
  resetStreaming(jid: string): void;
}

export interface ProgressSink {
  sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
}

export interface GroupDiscoverySource {
  syncGroups(force: boolean): Promise<void>;
}

export interface InteractionSurface {
  requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
  ): Promise<PermissionApprovalDecision>;
  requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
  ): Promise<UserQuestionResponse>;
}

export interface PlanReviewRequest {
  requestId: string;
  sourceAgentFolder: string;
  title: string;
  summary?: string;
  options: UserQuestionOption[];
}

export interface PlanReviewResponse {
  requestId: string;
  selected?: string;
  reviewedBy?: string;
}

export interface PlanReviewSurface {
  requestPlanReview(
    jid: string,
    request: PlanReviewRequest,
  ): Promise<PlanReviewResponse>;
}
