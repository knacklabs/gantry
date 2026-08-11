export type CapabilityTemplateAmendmentStatus =
  | 'pending'
  | 'approved'
  | 'denied';

export interface CapabilityTemplateAmendmentProposal {
  id: string;
  appId: string;
  agentId: string;
  capabilityId: string;
  canonicalKey: string;
  currentTemplates: string[];
  proposedTemplates: string[];
  observedArgv: string[];
  reviewedSchemaHash: string;
  widening: boolean;
  status: CapabilityTemplateAmendmentStatus;
  requestedBy: string;
  jobId?: string | null;
  conversationJid?: string | null;
  threadId?: string | null;
  providerAccountId?: string | null;
  decidedBy?: string;
  decisionReason?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
}

export interface CapabilityTemplateAmendmentRepository {
  claimPending(
    input: Omit<
      CapabilityTemplateAmendmentProposal,
      | 'status'
      | 'createdAt'
      | 'updatedAt'
      | 'decidedBy'
      | 'decisionReason'
      | 'decidedAt'
    > & { now: string },
  ): Promise<{
    proposal: CapabilityTemplateAmendmentProposal;
    created: boolean;
  }>;
  getById(id: string): Promise<CapabilityTemplateAmendmentProposal | null>;
  markDecision(input: {
    id: string;
    status: 'approved' | 'denied';
    decidedBy: string;
    decisionReason?: string;
    now: string;
  }): Promise<CapabilityTemplateAmendmentProposal | null>;
  amendSemanticCapabilityCommandTemplates(input: {
    proposalId: string;
    appId: string;
    capabilityId: string;
    expectedReviewedSchemaHash: string;
    proposedTemplates: string[];
    approvedBy: string;
    approvedAt: string;
  }): Promise<
    | { status: 'amended'; historyId: string; auditEventId: string }
    | { status: 'already_amended' }
    | { status: 'stale' }
    | { status: 'not_pending' }
  >;
}
