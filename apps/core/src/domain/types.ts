import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type { PermissionMode } from '../shared/permission-mode.js';
import type {
  PermissionApprovalRuleValue,
  PermissionApprovalUpdate,
} from '../shared/permission-approval-types.js';
import type { ReviewMessageView } from './review-message-view.js';
import type { MessageActionAffordance } from './message-actions.js';
import type { ObserverDigestMessageView } from './observer-digest-view.js';
import type { BrainReviewCardView } from './brain-review-card.js';
import type { PermissionApprovalResult } from './permission-approval-result.js';
export type { PermissionApprovalResult } from './permission-approval-result.js';
export type {
  MessageActionAffordanceKind,
  MemoryReviewActionDecision,
  BrainDreamReviewActionDecision,
  MessageActionAffordance,
  MessageActionCallbackInput,
  MemoryReviewMessageActionInput,
  ObserverFeedbackMessageActionInput,
  BrainDreamReviewMessageActionInput,
  MessageActionOutcome,
  OnMessageAction,
  OnMemoryReviewMessageAction,
  OnObserverFeedbackMessageAction,
  OnBrainDreamReviewMessageAction,
} from './message-actions.js';
export type {
  ReviewMessageView,
  ReviewMessageSide,
  ReviewMessageEvidence,
  ReviewMessageAffordance,
} from './review-message-view.js';
export type {
  ObserverDigestMessageView,
  ObserverDigestInsightView,
  ObserverFeedbackAffordance,
} from './observer-digest-view.js';

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
  conversationId?: string;
  trigger: string;
  added_at: string;
  agentId?: string;
  providerAccountId?: string;
  agentConfig?: AgentConfig;
  requiresTrigger?: boolean;
  conversationKind?: 'dm' | 'channel';
  providerConnectionId?: string;
  senderIdentityEvidenceType?: 'provider_user' | 'web_user';
  systemSenderIds?: string[];
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  name?: string;
  isGroup?: boolean;
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
  file_name?: string;
  provider_fetch?: {
    provider: string;
    kind: string;
    id: string;
    [key: string]: unknown;
  };
  deleted_at?: string;
}

// --- Channel capability ports ---
export type PermissionRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PermissionRiskCategory =
  | 'destructive'
  | 'privileged'
  | 'secret'
  | 'network'
  | 'filesystem'
  | 'benign';
export interface PermissionApprovalRequest {
  requestId: string;
  appId?: string;
  agentId?: string;
  providerAccountId?: string;
  personId?: string;
  responseNonce?: string;
  sourceAgentFolder: string;
  requestFamily?: 'tool' | 'admin' | 'review' | 'promotion';
  runHandle?: string;
  jobId?: string;
  setupFingerprint?: string;
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
  permissionLane?: 'interactive' | 'autonomous';
  expiresAt?: string;
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
  risk_level?: PermissionRiskLevel;
  risk_category?: PermissionRiskCategory;
  closestRule?: {
    rule: string;
    reason: string;
  };
  blockedPath?: string;
  toolInput?: Record<string, unknown>;
  hostInjectedCommandPrefix?: string;
  /** 16K-limit input evaluated by decision rails/effect keys, not the 500-char
   * display `toolInput`; set alongside it in IPC parsing. */
  classifierToolInput?: Record<string, unknown>;
  toolInputSanitized?: boolean;
  toolInputSanitizedPaths?: string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  suggestions?: PermissionApprovalUpdate[];
  decisionOptions?: PermissionApprovalDecisionMode[];
  /** Learned-root ask-once (PERM-2 Task G): the persistent-rule option means
   *  "remember this folder", so it approves without a tool-rule suggestion. */
  trustedRootLearn?: boolean;
  promotionHintCount?: number;
  firstAskedAt?: string;
  interaction?: InteractionDescriptor;
  permissionBatch?: {
    requestIds: string[];
    rows: string[];
  };
}

export interface PermissionApprovalCancellation {
  requestId: string;
  appId?: string;
  sourceAgentFolder: string;
  threadId?: string;
  reason?: string;
}

export type PermissionApprovalDecisionMode =
  | 'allow_once'
  | 'allow_persistent_rule'
  | 'cancel';

// prettier-ignore
export type PermissionDecisionSource =
  | 'durable_rule' | 'birthright' | 'deterministic_policy'
  | 'auto_classifier' | 'cached_classifier' | 'trusted_root'
  | 'human_once' | 'human_persistent';

export interface PermissionRecoveryEnvelope {
  version: 1;
  renderedDecisionOptions: PermissionApprovalDecisionMode[];
  targetJid: string | null;
  approvalContextJid: string | null;
  threadId: string | null;
  decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | null;
  renderedRequest: PermissionApprovalRequest;
}

export interface PermissionCallbackScope {
  appId: string;
  sourceAgentFolder: string;
  interactionId: string;
}

export interface PermissionCallbackClaimIntent {
  mode: PermissionApprovalDecisionMode;
  approverRef: string;
  decidedAt: string;
}

export interface PermissionCallbackClaimReference {
  id: string;
  scope: PermissionCallbackScope;
}

export interface PermissionCallbackClaim extends PermissionCallbackClaimReference {
  intent: PermissionCallbackClaimIntent;
  match: {
    kind: 'individual' | 'batch';
    canonicalId: string;
    providerAliases: string[];
  };
}

export type { PermissionApprovalRuleValue, PermissionApprovalUpdate };

export interface PermissionApprovalDecision {
  approved: boolean;
  mode?: PermissionApprovalDecisionMode;
  decidedBy?: string;
  source?: PermissionDecisionSource;
  repeatableForFutureRuns?: boolean;
  reason?: string;
  risk_level?: PermissionRiskLevel;
  risk_category?: PermissionRiskCategory;
  updatedPermissions?: PermissionApprovalUpdate[];
  decisionClassification?: 'user_temporary' | 'user_permanent' | 'user_reject';
  batchDecision?: 'review_each';
  permissionCallbackClaim?: PermissionCallbackClaimReference;
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
  permissionLane?: 'interactive' | 'autonomous';
  expiresAt?: string;
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

export interface QuestionRecoveryEnvelope {
  version: 1;
  targetJid: string | null;
  threadId: string | null;
  request: UserQuestionRequest;
  selections: Array<{ questionIndex: number; optionIndexes: number[] }>;
  completedQuestionIndexes: number[];
}

export interface UserQuestionResponse {
  requestId: string;
  answers: Record<string, string | string[]>;
  answeredBy?: string;
}

export interface UserQuestionCancellation {
  requestId: string;
  appId?: string;
  sourceAgentFolder: string;
  threadId?: string;
  reason?: string;
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
  /** Provider-card identity sampled when the update entered its ordering chain. */
  progressCardIdentity?: string;
  done?: boolean;
  replaceOnly?: boolean;
  generation?: number;
  actionOnly?: boolean;
  actionAffordances?: MessageActionAffordance[];
  /** Structured terminal view for done updates; providers that can render it
   * natively should prefer it over the text, others ignore it. */
  jobNotificationView?: JobNotificationView;
}

export interface StructuredJobResult {
  headline?: string;
  items: Array<{
    outcome: 'done' | 'skipped' | 'failed';
    label: string;
    detail?: string;
  }>;
  nextAction?: string;
}

export interface JobNotificationView {
  status: 'completed' | 'failed' | 'paused' | 'timeout' | 'dead_lettered';
  jobName: string;
  durationMs?: number;
  stats?: {
    toolCount: number;
    browserUsed: boolean;
    lastAction?: string;
  };
  result?: StructuredJobResult;
  fallbackText: string;
  nextRunAt?: string;
}

export interface MessageSendOptions {
  threadId?: string;
  providerAccountId?: string;
  agentId?: string;
  /** Provider message to edit in place for a durable living-card revision. */
  replaceMessageId?: string;
  /** Identity of a job-permission card revision; lets a provider settle zero-action retire/replace edits against the card. */
  jobPermissionCardRevision?: {
    callbackKey: string;
    revision: number;
    operation: 'send' | 'edit' | 'retire' | 'replace';
  };
  actionAffordances?: MessageActionAffordance[];
  files?: MessageFileAttachment[];
  /** When set, channels with native support render this as a compact-structured
   * memory-review message (per-channel native blocks/card) with the decision
   * buttons. Channels without native buttons fall back to `text`. */
  reviewMessageView?: ReviewMessageView;
  /** Structured terminal job notification for future native channel renderers.
   * Channels currently send `fallbackText`. */
  jobNotificationView?: JobNotificationView;
  /** Native one-message observer digest with feedback buttons. */
  observerDigestView?: ObserverDigestMessageView;
  /** When set, channels with native support render the destructive-proposal
   * review card (headline + detail) with its Approve/Reject
   * `brain_dream_review_decision` buttons. Channels without native buttons fall
   * back to `text`. */
  brainReviewView?: BrainReviewCardView;
  permissionCardView?: import('./permission-card.js').PermissionCardMessageView;
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

export type {
  ChannelLiveUxCapability,
  MessageReactionRemovalSink,
  MessageReactionSink,
  TypingSink,
} from './channel-live-ux.js';
export interface StreamingSink {
  sendStreamingChunk(
    jid: string,
    text: string,
    options?: StreamingChunkOptions,
  ): Promise<boolean>;
}
export interface StreamingStateSink {
  resetStreaming(jid: string, options?: { threadId?: string }): void;
}
export interface ProgressSink {
  progressCardIdentity?(
    jid: string,
    options?: ProgressUpdateOptions,
  ): string | undefined;
  sendProgressUpdate(
    jid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void | boolean>;
}
export interface GroupDiscoverySource {
  syncGroups(force: boolean): Promise<void>;
}

export interface InteractionSurface {
  requestPermissionApproval(
    jid: string,
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalResult>;
  requestUserAnswer(
    jid: string,
    request: UserQuestionRequest,
    onPromptDelivered?: (messageId: string, questionIndex?: number) => void,
  ): Promise<UserQuestionResponse>;
  questionIndexesForDeliveredPrompt?(
    request: UserQuestionRequest,
    firstQuestionIndex: number,
  ): number[];
  dropPendingInteraction?(
    kind: 'permission' | 'question',
    request: PermissionApprovalRequest | UserQuestionRequest,
  ): void;
  cancelPendingPermission?(
    request: PermissionApprovalCancellation,
  ): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
  cancelPendingQuestion?(
    request: UserQuestionCancellation,
  ): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
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
