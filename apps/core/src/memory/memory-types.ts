export type MemoryScope = 'user' | 'group' | 'global';
export const MEMORY_GLOBAL_GROUP_FOLDER = '_global';

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
}

export interface SaveMemoryInput {
  scope?: MemoryScope;
  group_folder?: string;
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
  group_folder?: string;
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
