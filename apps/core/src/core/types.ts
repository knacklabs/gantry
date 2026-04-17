export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Persisted schema key for the agent workspace path.
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
 * Stored at `AGENT_ROOT/mount-allowlist.json` and only editable from the host.
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
}

export interface NewMessage {
  id: string;
  chat_jid: string;
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
}

export type JobScheduleType = 'cron' | 'interval' | 'once' | 'manual';
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
  sourceGroup: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  blockedPath?: string;
  toolInput?: Record<string, unknown>;
}

export interface PermissionApprovalDecision {
  approved: boolean;
  decidedBy?: string;
  reason?: string;
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
  questions: UserQuestionItem[];
}

export interface UserQuestionResponse {
  requestId: string;
  answers: Record<string, string | string[]>;
  answeredBy?: string;
}

export interface StreamingChunkOptions {
  threadId?: string;
  done?: boolean;
  generation?: number;
}

export interface ProgressUpdateOptions {
  threadId?: string;
  done?: boolean;
}

export interface MessageSendOptions {
  threadId?: string;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;

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
  ): Promise<void>;
}

export interface TypingSink {
  setTyping(jid: string, isTyping: boolean): Promise<void>;
}

export interface StreamingSink {
  sendStreamingChunk(
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ): Promise<void>;
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
