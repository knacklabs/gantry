import type { SourceModelSnapshot } from '../../shared/source-model-snapshot.js';
import type { RequestSourceAnswer } from '@gantry/contracts';
import type { NormalizedMemorySubject } from '../../memory/memory-types.js';
export interface SourceLearningScope {
  appId: string;
  agentId: string;
  chatJid: string;
  personId: string;
  workspaceId: string;
  runId: string;
}
export interface SourceLearningProposal {
  kind: string;
  key: string;
  value: string;
  why?: string;
  source: 'discussion-explicit' | 'discussion-inferred';
  supportingSourceIds: string[];
}
export interface SourceLearningEvidence {
  sourceMessageId: string;
  authorId: string;
  text: string;
  createdAt: string;
  revisionId: string;
}
export interface SourceLearningContext {
  answerId: string;
  sessionId: string;
  conversationId: string;
  claimToken: string;
  request: RequestSourceAnswer;
  modelSnapshot?: SourceModelSnapshot;
  scope: SourceLearningScope;
  subject: NormalizedMemorySubject;
  deadlineAtMs: number;
}
export interface SourceLearningCandidate {
  id: string;
  context: SourceLearningContext;
  evidence: SourceLearningEvidence[];
  replayed: boolean;
}
