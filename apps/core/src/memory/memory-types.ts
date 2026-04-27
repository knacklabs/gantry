export type MemoryScope = 'user' | 'group' | 'global';
export const MEMORY_GLOBAL_GROUP_FOLDER = '_global';

export type MemorySubjectType = 'user' | 'group' | 'channel' | 'common';
export type MemoryVisibility = MemorySubjectType;
export type MemoryEvidenceSource =
  | 'session'
  | 'message'
  | 'tool'
  | 'manual'
  | 'knowledge_source';
export type DreamPhase = 'light' | 'rem' | 'deep' | 'all';
export type DreamDecisionAction =
  | 'stage_candidate'
  | 'promote'
  | 'merge'
  | 'rewrite'
  | 'pin'
  | 'decay'
  | 'retire'
  | 'needs_review'
  | 'no_op';

export interface MemoryBoundaryContext {
  /** Application namespace. Personal setup uses the seeded "default" app; SDK apps provide their stable app id. */
  appId: string;
  /** Agent/runtime owner. For channel agents this is the configured MyClaw agent folder/id. */
  agentId: string;
  /** Human actor identity when known. */
  userId?: string;
  /** Logical MyClaw/app group, not a provider-specific Telegram group. */
  groupId?: string;
  /** External provider conversation id: Telegram chat, Slack conversation, Teams channel/chat, or SDK conversation. */
  channelId?: string;
  /** Provider thread/topic/reply-chain id, such as Slack thread_ts, Telegram forum topic, or Teams reply chain. */
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
}

export interface AppMemorySearchInput extends Partial<MemoryBoundaryContext> {
  query?: string;
  limit?: number;
  includeCommon?: boolean;
  subjectTypes?: MemorySubjectType[];
}

export interface PatchAppMemoryInput extends Partial<MemoryBoundaryContext> {
  id: string;
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
  isAdminWrite?: boolean;
}

export interface DreamingTriggerInput extends Partial<MemoryBoundaryContext> {
  subjectType?: MemorySubjectType;
  subjectId?: string;
  phase?: DreamPhase;
  dryRun?: boolean;
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
  | 'project_fact'
  | 'reference';

export interface MemoryItem {
  id: string;
  scope: MemoryScope;
  group_folder: string;
  user_id: string | null;
  topic_id?: string | null;
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
  group_folder: string;
  topic_id?: string | null;
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
  group_folder: string;
  topic_id?: string | null;
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
  group_folder: string;
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
  isMain: boolean;
  groupFolder: string;
  actor?: string;
  threadId?: string;
}

export interface SaveMemoryInput {
  scope?: MemoryScope;
  group_folder?: string;
  user_id?: string;
  topic_id?: string;
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
  group_folder?: string;
  topic_id?: string;
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

export function normalizeMemoryTopicId(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 255) : undefined;
}
