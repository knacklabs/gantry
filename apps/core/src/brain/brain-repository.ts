import type {
  BrainEdge,
  BrainEdgeType,
  BrainEmbeddingConfig,
  BrainEntity,
  BrainEntityKind,
  BrainGraph,
  BrainPage,
  BrainPageSourceKind,
  BrainStatus,
} from './brain-types.js';

export interface BrainPageWrite {
  appId: string;
  slug: string;
  title: string;
  markdown: string;
  sourceKind: BrainPageSourceKind;
  sourceRef?: string | null;
  authorId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BrainEntityWrite {
  kind: BrainEntityKind;
  name: string;
  normalizedName: string;
}

export interface BrainEdgeWrite {
  type: BrainEdgeType;
  fromEntityId: string;
  toEntityId: string;
}

export interface BrainRankedPage {
  page: BrainPage;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  reasons: string[];
}

export interface BrainPendingEmbeddingPage {
  page: BrainPage;
  contentHash: string;
  text: string;
}

export interface BrainDreamCursor {
  updatedAt: string;
  pageId: string;
}

export interface BrainDreamDecisionWrite {
  id: string;
  appId: string;
  runId: string;
  pageId?: string | null;
  op: Record<string, unknown>;
  outcome: 'applied' | 'noop' | 'rejected' | 'proposed';
  reason: string;
}

export interface BrainRepository {
  getPageBySlug(appId: string, slug: string): Promise<BrainPage | null>;
  upsertPage(
    input: BrainPageWrite,
  ): Promise<{ page: BrainPage; created: boolean }>;
  getEntityByName(
    appId: string,
    kind: BrainEntityKind,
    normalizedName: string,
  ): Promise<BrainEntity | null>;
  upsertEntities(
    appId: string,
    entities: BrainEntityWrite[],
  ): Promise<BrainEntity[]>;
  getEdge(input: {
    appId: string;
    type: BrainEdgeType;
    fromEntityId: string;
    toEntityId: string;
    evidencePageId: string;
  }): Promise<BrainEdge | null>;
  upsertEdges(
    appId: string,
    pageId: string,
    edges: BrainEdgeWrite[],
  ): Promise<BrainEdge[]>;
  replacePageEdges(
    appId: string,
    pageId: string,
    edges: BrainEdgeWrite[],
  ): Promise<BrainEdge[]>;
  searchLexical(input: {
    appId: string;
    query: string;
    limit: number;
  }): Promise<BrainRankedPage[]>;
  searchVector(input: {
    appId: string;
    vector: number[];
    embedding: BrainEmbeddingConfig;
    limit: number;
  }): Promise<BrainRankedPage[]>;
  graphForPages(appId: string, pageIds: string[]): Promise<BrainGraph>;
  findPeopleWorkingAt(
    appId: string,
    companyName: string,
  ): Promise<
    Array<{ person: BrainEntity; company: BrainEntity; page: BrainPage }>
  >;
  writePageEmbedding(input: {
    pageId: string;
    embedding: BrainEmbeddingConfig;
    contentHash: string;
    vector: number[];
  }): Promise<void>;
  markPageEmbeddingError(input: {
    pageId: string;
    embedding: BrainEmbeddingConfig;
    contentHash: string;
    error: string;
  }): Promise<void>;
  listPendingEmbeddingPages(input: {
    appId: string;
    embedding: BrainEmbeddingConfig;
    limit: number;
  }): Promise<BrainPendingEmbeddingPage[]>;
  getDreamCursor(appId: string): Promise<BrainDreamCursor | null>;
  listPagesForDream(input: {
    appId: string;
    cursor?: BrainDreamCursor | null;
    limit: number;
  }): Promise<BrainPage[]>;
  saveDreamCursor(appId: string, cursor: BrainDreamCursor): Promise<void>;
  journalDreamDecision(input: BrainDreamDecisionWrite): Promise<void>;
  status(appId: string, embedding?: BrainEmbeddingConfig): Promise<BrainStatus>;
}
