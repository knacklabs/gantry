import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
import type { PermissionApprovalUpdate } from '../shared/permission-approval-types.js';
import type { PermissionCardAffordances } from './permission-card-affordances.js';
import type {
  InteractionDescriptor,
  PermissionApprovalDecisionMode,
  PermissionRiskCategory,
  PermissionRiskLevel,
} from './types.js';

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
  /** Engine tool-call id the host gate pins to the run and action; see pinPermissionInvocationId. */
  invocationId?: string;
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
  attachmentOpenIds?: { wellFormed: boolean; count: number };
  toolInputSanitized?: boolean;
  toolInputSanitizedPaths?: string[];
  semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
  suggestions?: PermissionApprovalUpdate[];
  decisionOptions?: PermissionApprovalDecisionMode[];
  cardAffordances?: PermissionCardAffordances;
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
