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

/**
 * Mount allowlist configuration for additional host mounts.
 * Stored at `MYCLAW_HOME/mount-allowlist.json` and only editable from the host.
 */
export interface MountAllowlist {
  // Directories that can be exposed to agent runs.
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
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
  model?: string; // Optional model alias/full name for this group
  thinking?: ThinkingOverride; // Optional thinking override for this group
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
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
export type JobExecutionMode = 'parallel' | 'serialized';

export type JobStatus =
  | 'active'
  | 'paused'
  | 'running'
  | 'completed'
  | 'dead_lettered';

export interface Job {
  id: string;
  name: string;
  prompt: string;
  model?: string | null;
  script?: string | null;
  schedule_type: JobScheduleType;
  schedule_value: string;
  status: JobStatus;
  linked_sessions: string[];
  session_id: string | null;
  thread_id: string | null;
  group_scope: string;
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
  execution_mode: JobExecutionMode;
  lease_run_id: string | null;
  lease_expires_at: string | null;
  pause_reason: string | null;
  capability_policy?: {
    allowed_tools: string[];
  };
}

export type JobRunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'dead_lettered';

export interface JobRun {
  run_id: string;
  job_id: string;
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
  responseNonce?: string;
  sourceGroup: string;
  targetJid?: string;
  approvalContextJid?: string;
  threadId?: string;
  decisionPolicy?: 'control_allowlist' | 'same_channel';
  toolName: string;
  toolUseID?: string;
  agentID?: string;
  subagentType?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolInput?: Record<string, unknown>;
  suggestions?: PermissionApprovalUpdate[];
  decisionOptions?: PermissionApprovalDecisionMode[];
  interaction?: InteractionDescriptor;
}

export type PermissionApprovalDecisionMode =
  | 'allow_once'
  | 'allow_persistent_rule'
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
  sourceGroup: string;
  targetJid?: string;
  threadId?: string;
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
    sourceGroup?: string;
    targetJid?: string;
    threadId?: string;
    toolName?: string;
    capabilityType?: string;
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
}

export interface MessageSendOptions {
  threadId?: string;
}

export type MessageDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'failed'
  | 'partially_sent';

export interface MessageDeliveryResult {
  externalMessageId?: string;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (
  chatJid: string,
  message: NewMessage,
) => Promise<void>;

// Callback for chat metadata discovery.
// name is optional for providers that deliver names inline; channels that sync
// names separately omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => Promise<void>;

export interface InboundMessageSource {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export interface ChannelLifecyclePort {
  name: string;
  connect(): Promise<void>;
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
  sourceGroup: string;
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
