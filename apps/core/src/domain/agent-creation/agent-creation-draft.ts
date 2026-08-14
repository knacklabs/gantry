import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';
import type { AppId } from '../app/app.js';
import type { AgentId } from '../agent/agent.js';

export type AgentCreationDraftId = BrandedId<'AgentCreationDraftId'>;
export type AgentCreationDraftStatus =
  | 'draft'
  | 'applying'
  | 'needs_attention'
  | 'completed';

export interface AgentCreationDraft {
  id: AgentCreationDraftId;
  appId: AppId;
  revision: number;
  status: AgentCreationDraftStatus;
  currentStep: string;
  document: Record<string, unknown>;
  progress: Record<string, unknown>;
  agentId?: AgentId;
  jobId?: string;
  errorCode?: string;
  errorMessage?: string;
  leaseToken?: string;
  leaseExpiresAt?: IsoTimestamp;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt?: IsoTimestamp;
}
