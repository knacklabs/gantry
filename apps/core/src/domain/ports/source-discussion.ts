import type { RequestSourceAnswer } from '@gantry/contracts';
import type { NewMessage } from '../types.js';
export interface SourceSummaryWork {
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
  messages: NewMessage[];
  selectedSourceIds: string[];
  claimToken: string;
  executionAuthorityDeadline?: number;
  contextSummary?: string;
  summaryWork?: SourceSummaryWork;
}
