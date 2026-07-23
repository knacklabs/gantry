export type MemoryScope = 'user' | 'group' | 'global';
export const MEMORY_GLOBAL_WORKSPACE_FOLDER = '_global';

export const DIRECT_SAVE_MEMORY_KINDS = [
  'preference',
  'decision',
  'fact',
  'correction',
  'constraint',
] as const satisfies readonly MemoryKind[];

export type DirectSaveMemoryKind = (typeof DIRECT_SAVE_MEMORY_KINDS)[number];

export function isDirectSaveMemoryKind(
  value: unknown,
): value is DirectSaveMemoryKind {
  return (
    typeof value === 'string' &&
    (DIRECT_SAVE_MEMORY_KINDS as readonly string[]).includes(value)
  );
}

export type MemorySubjectType = 'user' | 'group' | 'channel' | 'common';
export type MemoryVisibility = MemorySubjectType;
export type MemoryEvidenceSource =
  'session' | 'message' | 'tool' | 'manual' | 'knowledge_source';
export type DreamPhase = 'light' | 'rem' | 'deep' | 'all';
export type DreamDecisionAction =
  | 'stage_candidate'
  | 'promote'
  | 'update'
  | 'skip'
  | 'blocked'
  | 'dry_run'
  | 'merge'
  | 'rewrite'
  | 'pin'
  | 'decay'
  | 'retire'
  | 'needs_review'
  | 'no_op';

export type MemoryReviewDecision = 'approve' | 'reject' | 'edit_approve';

export type MemoryProposalAction =
  | 'stage_candidate'
  | 'promote'
  | 'update'
  | 'retire'
  | 'needs_review'
  | 'skip'
  | 'keep'
  | 'merge'
  | 'rewrite';

export interface MemoryLifecycleProposal {
  action: MemoryProposalAction;
  candidateId?: string;
  itemId?: string;
  itemIds?: string[];
  targetItemId?: string;
  kind?: MemoryKind;
  key?: string;
  value?: string;
  reason: string;
  confidence: number;
  evidenceIds: string[];
}

export interface MemoryReviewReadableItem {
  itemId: string;
  kind?: MemoryKind | string;
  key?: string;
  value?: string;
}

export interface MemoryReviewProposedChange {
  action: MemoryProposalAction;
  summary: string;
  before?: MemoryReviewReadableItem | null;
  after?: {
    kind?: MemoryKind | string;
    key?: string;
    value?: string;
  } | null;
  target?: MemoryReviewReadableItem | null;
  retiring?: MemoryReviewReadableItem[];
  reason: string;
  confidence: number;
  evidenceIds: string[];
}

export interface MemoryReviewEvidenceSnippet {
  evidenceId: string;
  sourceType: MemoryEvidenceSource | string;
  sourceId?: string | null;
  snippet: string;
  createdAt: string;
}

export interface MemoryReviewPageSubject {
  appId: string;
  agentId: string;
  subjectType: MemorySubjectType;
  subjectId: string;
}

export interface MemoryReviewPageContext {
  subject: MemoryReviewPageSubject;
  limit: number;
  offset: number;
  reviewIds: string[];
}

export interface MemoryReviewPageItem {
  number: number;
  reviewId: string;
  action: MemoryProposalAction;
  summary: string;
  before?: MemoryReviewReadableItem | null;
  after?: {
    kind?: MemoryKind | string;
    key?: string;
    value?: string;
  } | null;
  target?: MemoryReviewReadableItem | null;
  retiring?: MemoryReviewReadableItem[];
  reason: string;
  confidence: number;
  evidenceIds: string[];
  evidence: MemoryReviewEvidenceSnippet[];
  decisionOptions: MemoryReviewDecision[];
}

export interface MemoryReviewDisplayPage {
  items: MemoryReviewPageItem[];
  pageContext: MemoryReviewPageContext;
  totalCount: number;
  returnedCount: number;
  remainingCount: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface MemoryReviewRecord extends NormalizedMemorySubject {
  id: string;
  runId: string;
  phase: DreamPhase;
  proposal: MemoryLifecycleProposal;
  proposedChange?: MemoryReviewProposedChange;
  status: 'pending_review' | 'approved' | 'rejected' | 'applied' | 'failed';
  itemVersions: Record<string, number>;
  candidateVersions: Record<string, string>;
  validationSummary: string;
  reviewerId?: string | null;
  decision?: MemoryReviewDecision | null;
  editedValue?: string | null;
  editedReason?: string | null;
  applyOutcome?: string | null;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | null;
}

export interface BlockedDreamDecision extends NormalizedMemorySubject {
  id: string;
  runId: string;
  itemId?: string | null;
  candidateId?: string | null;
  rationale: string;
  kind?: string | null;
  key?: string | null;
  value?: string | null;
  createdAt: string;
}

export interface MemoryReviewPage {
  reviews: MemoryReviewRecord[];
  reviewPage?: MemoryReviewDisplayPage;
  totalCount: number;
  returnedCount: number;
  remainingCount: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
}

export interface MemoryReviewDecisionInput extends Partial<MemoryBoundaryContext> {
  reviewId: string;
  decision: MemoryReviewDecision;
  subjectType?: MemorySubjectType;
  subjectId?: string;
  editedValue?: string;
  editedReason?: string;
  reviewerId?: string;
}

export interface MemoryBoundaryContext {
  /** Application namespace. Personal setup uses the seeded "default" app; SDK apps provide their stable app id. */
  appId: string;
  /** Agent/runtime owner. For channel agents this is the configured Gantry agent folder/id. */
  agentId: string;
  /** Human actor identity when known. */
  userId?: string;
  /** Logical Gantry/app group, not a provider-specific Telegram group. */
  groupId?: string;
  /** External provider conversation id: Telegram chat, Slack conversation, Teams channel/chat, or SDK conversation. */
  channelId?: string;
  /** Runtime routing thread/topic id. Memory subject resolution intentionally ignores this. */
  threadId?: string;
}

export interface NormalizedMemorySubject extends MemoryBoundaryContext {
  subjectType: MemorySubjectType;
  subjectId: string;
}

export interface AppMemoryItem extends MemoryBoundaryContext {
  id: string;
  subjectType: MemorySubjectType;
  subjectId: string;
  kind: MemoryKind;
  key: string;
  value: string;
  why?: string | null;
  confidence: number;
  isPinned: boolean;
  version: number;
  source: string;
  evidenceIds: string[];
  retrievalCount?: number;
  totalScore?: number;
  maxScore?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEvidenceRecord extends NormalizedMemorySubject {
  id: string;
  sourceType: MemoryEvidenceSource;
  sourceId?: string | null;
  actorId?: string | null;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AppMemorySearchResult {
  item: AppMemoryItem;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  reasons: string[];
}

export interface SaveAppMemoryInput extends Partial<MemoryBoundaryContext> {
  subjectType?: MemorySubjectType;
  subjectId?: string;
  visibility?: MemoryVisibility;
  kind?: MemoryKind;
  key: string;
  value: string;
  why?: string;
  confidence?: number;
  source?: string;
  evidenceText?: string;
  evidenceIds?: string[];
  actorId?: string;
  isAdminWrite?: boolean;
  dreamingPromotion?: {
    runId: string;
    promotedAt: string;
    candidateId?: string;
  };
}

export interface AppMemorySearchInput extends Partial<MemoryBoundaryContext> {
  query?: string;
  limit?: number;
  includeCommon?: boolean;
  subjectTypes?: MemorySubjectType[];
}

export interface PatchAppMemoryInput extends Partial<MemoryBoundaryContext> {
  id: string;
  subjectType?: MemorySubjectType;
  subjectId?: string;
  expectedVersion?: number;
  key?: string;
  value?: string;
  why?: string | null;
  confidence?: number;
  isPinned?: boolean;
  isAdminWrite?: boolean;
}

export interface DeleteAppMemoryInput extends Partial<MemoryBoundaryContext> {
  id: string;
  expectedVersion?: number;
  isAdminWrite?: boolean;
}

export interface DemoteDreamingMemoryInput extends Partial<MemoryBoundaryContext> {
  id: string;
  expectedVersion?: number;
  isAdminWrite?: boolean;
  actorId?: string;
  reason?: string;
}

export interface DreamingTriggerInput extends Partial<MemoryBoundaryContext> {
  subjectType?: MemorySubjectType;
  subjectId?: string;
  phase?: DreamPhase;
  dryRun?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

export interface DreamingRunStatus {
  runId: string;
  appId: string;
  agentId: string;
  subjectType: MemorySubjectType;
  subjectId: string;
  phase: DreamPhase;
  status: 'running' | 'completed' | 'failed';
  summary: Record<string, unknown>;
  startedAt: string;
  completedAt?: string | null;
}

export type MemoryKind =
  | 'preference'
  | 'decision'
  | 'fact'
  | 'correction'
  | 'constraint'
  | 'reference';

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  workspace_folder: string;
  user_id: string | null;
  kind: MemoryKind;
  key: string;
  value: string;
  why?: string;
  load_bearing?: boolean;
  source_turn_id?: string | null;
  source: string;
  source_folder?: string;
  file_path?: string;
  content_hash?: string;
  indexed_at?: string | null;
  embedding_pending?: boolean;
  blocked_reason?: string | null;
  confidence: number;
  is_pinned: boolean;
  used_count?: number;
  superseded_by?: string | null;
  is_deleted?: boolean;
  deleted_at?: string | null;
  last_reviewed_at?: string | null;
  version: number;
  last_used_at: string | null;
  last_retrieved_at: string | null;
  retrieval_count: number;
  total_score: number;
  max_score: number;
  query_hashes_json: string;
  recall_days_json: string;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryProcedure {
  id: string;
  scope: MemoryScope;
  workspace_folder: string;
  title: string;
  body: string;
  tags: string[];
  origin?: 'explicit' | 'accepted_suggestion';
  trigger?: string | null;
  source: string;
  confidence: number;
  is_deleted?: boolean;
  deleted_at?: string | null;
  version: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryChunk {
  id: string;
  source_type: string;
  source_id: string;
  source_path: string;
  scope: MemoryScope;
  workspace_folder: string;
  kind: string;
  chunk_hash: string;
  text: string;
  token_count: number;
  importance_weight: number;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  id: string;
  source_type: string;
  source_path: string;
  text: string;
  scope: MemoryScope;
  workspace_folder: string;
  created_at: string;
  lexical_score: number;
  vector_score: number;
  fused_score: number;
}

export interface SimilarMemoryItemMatch {
  item: MemoryItem;
  similarity: number;
}

export interface MemoryWriteContext {
  workspaceFolder: string;
  actor?: string;
  threadId?: string;
}

export interface SaveMemoryInput {
  scope?: MemoryScope;
  workspace_folder?: string;
  user_id?: string;
  kind?: MemoryKind;
  key: string;
  value: string;
  why?: string;
  load_bearing?: boolean;
  source_turn_id?: string;
  confidence?: number;
  source?: string;
  supersedes?: string[];
}

export interface PatchMemoryInput {
  id: string;
  expected_version: number;
  key?: string;
  value?: string;
  why?: string;
  load_bearing?: boolean;
  confidence?: number;
}

export interface SaveProcedureInput {
  scope?: MemoryScope;
  workspace_folder?: string;
  user_id?: string;
  title: string;
  body: string;
  tags?: string[];
  origin?: 'explicit' | 'accepted_suggestion';
  trigger?: string;
  confidence?: number;
  source?: string;
}

export interface PatchProcedureInput {
  id: string;
  expected_version: number;
  title?: string;
  body?: string;
  tags?: string[];
  trigger?: string | null;
  confidence?: number;
}
