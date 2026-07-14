import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type { PermissionMode } from '../shared/permission-mode.js';

export type {
  Job,
  JobAccessRequirement,
  JobAccessRequirementTarget,
  JobCapabilityRequirement,
  JobCapabilityRequirementImplementation,
  JobCapabilityRequirementImplementationKind,
  JobEvent,
  JobExecutionContext,
  JobNotificationRoute,
  JobRecoveryIntent,
  JobRecoveryIntentKind,
  JobRecoveryIntentState,
  JobRun,
  JobRunStatus,
  JobScheduleType,
  JobSetupBlocker,
  JobSetupReadinessState,
  JobSetupState,
  JobStatus,
} from './job-types.js';

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

export type AgentControlThinking =
  | { mode: 'off'; budgetTokens?: never }
  | { mode: 'on'; budgetTokens?: number };
export type AgentControlEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentControlOverrides {
  effort?: AgentControlEffort;
  thinking?: AgentControlThinking;
  maxOutputTokens?: number;
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
  permissionMode?: PermissionMode;
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface ConversationRoute {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  agentId?: string;
  providerAccountId?: string;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean;
  conversationKind?: 'dm' | 'channel';
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  provider?: string;
  providerAccountId?: string;
  agentId?: string;
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
  responseSchema?: Record<string, unknown>;
  agentControls?: AgentControlOverrides;
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

// --- Channel capability ports ---
export interface PermissionApprovalRequest {
  requestId: string;
  appId?: string;
  agentId?: string;
  providerAccountId?: string;
  responseNonce?: string;
  sourceAgentFolder: string;
  requestFamily?: 'tool' | 'admin' | 'review' | 'promotion';
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
  unattended?: boolean;
  senderId?: string;
  turnIntentSummary?: string;
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
  toolInputSanitized?: boolean;
  toolInputSanitizedPaths?: string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  suggestions?: PermissionApprovalUpdate[];
  decisionOptions?: PermissionApprovalDecisionMode[];
  promotionHintCount?: number;
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
  sourceAgentFolder: string;
  appId?: string;
  agentId?: string;
  providerAccountId?: string;
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

export type RichInteractionKind =
  | 'status'
  | 'facts'
  | 'list'
  | 'table'
  | 'form'
  | 'media'
  | 'progress';

export const RICH_INTERACTION_NATIVE_FALLBACK_TEXT =
  'Rich view unavailable in this conversation. Showing text version.';

export interface RichInteractionDescriptor {
  kind: RichInteractionKind;
  fallbackText: string;
  payload: Record<string, unknown>;
}

export interface RichInteractionRequest {
  requestId: string;
  sourceAgentFolder: string;
  appId?: string;
  agentId?: string;
  providerAccountId?: string;
  jobId?: string;
  runId?: string;
  targetJid?: string;
  threadId?: string;
  descriptor: InteractionDescriptor;
}

export interface InteractionDescriptor {
  id: string;
  title: string;
  body?: string;
  fallbackText?: string;
  rich?: RichInteractionDescriptor;
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
  providerAccountId?: string;
  done?: boolean;
  generation?: number;
}

export interface ProgressUpdateOptions {
  threadId?: string;
  providerAccountId?: string;
  done?: boolean;
  replaceOnly?: boolean;
  generation?: number;
  actionOnly?: boolean;
  actionAffordances?: MessageActionAffordance[];
}

export type MessageActionAffordanceKind =
  | 'scheduler_run_now'
  | 'scheduler_pause_job'
  | 'live_turn_stop';

export type MessageActionAffordance =
  | {
      kind: 'scheduler_run_now' | 'scheduler_pause_job';
      label: string;
      jobId: string;
      runId?: string | null;
    }
  | {
      kind: 'live_turn_stop';
      label: string;
      actionToken: string;
    };

export type MessageActionCallbackInput =
  | {
      kind: 'live_turn_stop';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId?: string;
      actionToken?: string;
    }
  | {
      kind: 'scheduler_run_now';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId?: string;
      jobId: string;
      runId?: string | null;
    };

export type OnMessageAction = (
  input: MessageActionCallbackInput,
) => Promise<void>;

export interface MessageSendOptions {
  threadId?: string;
  providerAccountId?: string;
  agentId?: string;
  actionAffordances?: MessageActionAffordance[];
  files?: MessageFileAttachment[];
}

export interface MessageFileAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  content: Uint8Array;
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
  options?: { providerAccountId?: string },
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

export interface MessageReactionSink {
  addReaction(jid: string, messageRef: string, emoji: string): Promise<void>;
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

export interface RichInteractionSurface {
  renderRichInteraction(
    jid: string,
    request: RichInteractionRequest,
  ): Promise<void | boolean>;
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
