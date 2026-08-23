export type JobPermissionNeedState =
  | 'asking'
  | 'approved_pending_apply'
  | 'applied'
  | 'denied_pending_delivery'
  | 'denied'
  | 'handoff_pending'
  | 'handed_off'
  | 'cancelled';

export type JobPermissionWaiterState =
  | 'awaiting_card_delivery'
  | 'release_pending'
  | 'waiting'
  | 'response_pending'
  | 'delivered'
  | 'retired'
  | 'handoff';

export interface JobPermissionWaiter {
  id: string;
  requestId: string;
  responseId: string;
  runId: string;
  runLeaseToken: string;
  runLeaseFencingVersion: number;
  state: JobPermissionWaiterState;
  slotReleased: boolean;
  responseDeliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobPermissionActorContext {
  actorRef: string;
  conversationJid?: string;
  providerAccountId?: string;
  threadId?: string;
}

export interface JobPermissionNeedRecord {
  schemaVersion: 1;
  recordType: 'job_permission_need';
  id: string;
  appId: string;
  jobId: string;
  sourceAgentFolder: string;
  canonicalIdentity: string;
  displayLabel: string;
  askingEpoch: number;
  state: JobPermissionNeedState;
  renderedGrantAtoms: string[];
  approvedGrantAtoms: string[] | null;
  waitStartedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  denialReason: string | null;
  policyChangedReason: string | null;
  grantAppliedAt: string | null;
  requestSnapshots: Array<{
    requestId: string;
    request: PermissionApprovalRequest;
  }>;
  waiters: JobPermissionWaiter[];
  createdAt: string;
  updatedAt: string;
}

export interface JobPermissionCardRowSnapshot {
  needId: string;
  askingEpoch: number;
  displayLabel: string;
  renderedGrantAtoms: string[];
  visibleGrantAtoms: string[];
  scopeFullyVisible: boolean;
  actionEnabled: boolean;
  denyEnabled: boolean;
  action:
    | 'allow_and_continue'
    | 'approve_and_run_again'
    | 'reconsider'
    | 'show_scope';
}

export interface JobPermissionCardRevision {
  revision: number;
  operation: 'send' | 'edit' | 'retire' | 'replace';
  deliveryId: string;
  deliveryItemId: string;
  rows: JobPermissionCardRowSnapshot[];
  batchNeedIds: string[];
  pageStart: number;
  hiddenRowCount: number;
  createdAt: string;
}

export interface JobPermissionRerunBarrier {
  priorRunId: string;
  requiredNeeds: Array<{ needId: string; askingEpoch: number }>;
  requestedAt: string;
  requestedBy: string;
  enqueuedAt: string | null;
}

export interface JobPermissionPendingBudget {
  runId: string;
  openCount: number;
  accumulatedMs: number;
  hostBootId: string | null;
  lastMonotonicMs: number | null;
}

export interface JobPermissionCardRecord {
  schemaVersion: 1;
  recordType: 'job_permission_card';
  id: string;
  appId: string;
  jobId: string;
  callbackKey: string;
  sourceAgentFolder: string;
  conversationId: string;
  threadId: string | null;
  agentId: string | null;
  revision: number;
  currentProviderMessageId: string | null;
  currentProvider: string | null;
  currentProviderRevision: number;
  pageOffset: number;
  fullScopeNeedId: string | null;
  fullScopeAskingEpoch: number | null;
  revisions: JobPermissionCardRevision[];
  pendingBudgets: JobPermissionPendingBudget[];
  rerunBarriers: JobPermissionRerunBarrier[];
  createdAt: string;
  updatedAt: string;
}

export interface JobPermissionDurabilityState {
  card: JobPermissionCardRecord;
  needs: JobPermissionNeedRecord[];
}

export type JobPermissionCardDeliveryOutcome =
  | { status: 'pending' }
  | {
      status: 'delivered';
      provider: string | null;
      providerMessageId: string;
      deliveredAt: string;
    }
  | { status: 'ambiguous' | 'exhausted' | 'cancelled'; reason: string };

export interface JobPermissionDurabilityRepository {
  mutateJobPermissionState<T>(input: {
    appId: string;
    jobId: string;
    initialCard: JobPermissionCardRecord;
    mutate: (state: JobPermissionDurabilityState) => {
      state: JobPermissionDurabilityState;
      result: T;
    };
  }): Promise<T>;
  listJobPermissionNeedsForReconciliation(input?: {
    limit?: number;
  }): Promise<JobPermissionNeedRecord[]>;
  getJobPermissionState(input: {
    appId: string;
    jobId: string;
  }): Promise<JobPermissionDurabilityState | null>;
  getJobPermissionCardDeliveryOutcome(input: {
    appId: string;
    deliveryId: string;
  }): Promise<JobPermissionCardDeliveryOutcome | null>;
  findJobPermissionStateByCallbackKey(input: {
    callbackKey: string;
  }): Promise<JobPermissionDurabilityState | null>;
}
import type { PermissionApprovalRequest } from '../types.js';
