import type { SourceModelSnapshot } from '../../shared/source-model-snapshot.js';
import type { RequestSourceAnswer } from '@gantry/contracts';
import type { NewMessage } from '../types.js';
export interface SourceSummaryWork {
  inputTokens?: number;
  id: string;
  mode: 'recent' | 'ancestry';
  generation: number;
  workspaceId: string;
  sourceVersion: string;
  profileVersion: string;
  sourceIds: string[];
  throughPosition: string;
  previousDigestId?: string;
  previousText?: string;
  messages: NewMessage[];
}
export interface PreparedSourceAnswer {
  id: string;
  request: RequestSourceAnswer;
  modelSnapshot?: SourceModelSnapshot;
  messages: NewMessage[];
  selectedSourceIds: string[];
  claimToken: string;
  executionAuthorityDeadline?: number;
  contextSummary?: string;
  summaryWork?: SourceSummaryWork;
  summaryCandidate?: SourceSummaryWork;
}
