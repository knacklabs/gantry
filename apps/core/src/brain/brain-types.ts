export const BRAIN_ENTITY_KINDS = [
  'person',
  'company',
  'project',
  'topic',
] as const;
export type BrainEntityKind = (typeof BRAIN_ENTITY_KINDS)[number];

export const BRAIN_EDGE_TYPES = [
  'works_at',
  'member_of',
  'mentions',
  'authored',
  'assigned_to',
  'relates_to',
] as const;
export type BrainEdgeType = (typeof BRAIN_EDGE_TYPES)[number];

export type BrainPageSourceKind = 'import' | 'agent' | 'user';

export interface BrainPage {
  id: string;
  appId: string;
  slug: string;
  title: string;
  markdown: string;
  sourceKind: BrainPageSourceKind;
  sourceRef: string | null;
  authorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BrainEntity {
  id: string;
  appId: string;
  kind: BrainEntityKind;
  name: string;
  normalizedName: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrainEdge {
  id: string;
  appId: string;
  type: BrainEdgeType;
  fromEntityId: string;
  toEntityId: string;
  evidencePageId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrainGraph {
  entities: BrainEntity[];
  edges: BrainEdge[];
}

export interface BrainSearchResult {
  page: BrainPage;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  reasons: string[];
  snippet: string;
  graph: BrainGraph;
}

export interface BrainCitation {
  pageId: string;
  title: string;
  slug: string;
}

export interface BrainQueryResult {
  answer: string;
  citations: BrainCitation[];
  gaps: string;
  results: BrainSearchResult[];
}

export interface BrainStatus {
  pages: number;
  entities: number;
  edges: number;
  readyEmbeddings: number;
  pendingEmbeddings: number;
}

export interface BrainEmbeddingConfig {
  provider: string;
  model: string;
  dimensions: number;
}
