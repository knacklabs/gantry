import type { AppId } from '../app/app.js';
import type {
  AgentCreationDraft,
  AgentCreationDraftId,
} from '../agent-creation/agent-creation-draft.js';

export interface AgentCreationDraftRepository {
  listDrafts(appId: AppId): Promise<AgentCreationDraft[]>;
  getDraft(input: {
    appId: AppId;
    id: AgentCreationDraftId;
  }): Promise<AgentCreationDraft | null>;
  saveDraft(input: {
    draft: AgentCreationDraft;
    expectedRevision?: number;
  }): Promise<AgentCreationDraft | 'conflict'>;
  deleteDraft(input: {
    appId: AppId;
    id: AgentCreationDraftId;
  }): Promise<'deleted' | 'not_found' | 'agent_exists'>;
  claimDraft(input: {
    appId: AppId;
    id: AgentCreationDraftId;
    leaseToken: string;
    leaseExpiresAt: string;
    now: string;
  }): Promise<AgentCreationDraft | null>;
  deleteCompletedBefore(input: {
    before: string;
    limit: number;
  }): Promise<number>;
}
