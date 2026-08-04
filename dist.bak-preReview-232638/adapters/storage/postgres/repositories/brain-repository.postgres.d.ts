import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { BrainEdge, BrainEmbeddingConfig, BrainEntity, BrainGraph, BrainPage, BrainStatus } from '../../../../brain/brain-types.js';
import type { BrainEdgeWrite, BrainDreamCursor, BrainDreamDecisionWrite, BrainEntityWrite, BrainPageWrite, BrainPendingEmbeddingPage, BrainRankedPage, BrainRepository } from '../../../../brain/brain-repository.js';
import * as pgSchema from '../schema/schema.js';
type Db = NodePgDatabase<typeof pgSchema>;
export declare class PostgresBrainRepository implements BrainRepository {
    private readonly db;
    constructor(db: Db);
    getPageBySlug(appId: string, slug: string): Promise<BrainPage | null>;
    upsertPage(input: BrainPageWrite): Promise<{
        page: BrainPage;
        created: boolean;
    }>;
    getEntityByName(appId: string, kind: BrainEntity['kind'], normalizedName: string): Promise<BrainEntity | null>;
    upsertEntities(appId: string, entities: BrainEntityWrite[]): Promise<BrainEntity[]>;
    replacePageEdges(appId: string, pageId: string, edges: BrainEdgeWrite[]): Promise<BrainEdge[]>;
    getEdge(input: {
        appId: string;
        type: BrainEdge['type'];
        fromEntityId: string;
        toEntityId: string;
        evidencePageId: string;
    }): Promise<BrainEdge | null>;
    upsertEdges(appId: string, pageId: string, edges: BrainEdgeWrite[]): Promise<BrainEdge[]>;
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
    findPeopleWorkingAt(appId: string, companyName: string): Promise<Array<{
        person: BrainEntity;
        company: BrainEntity;
        page: BrainPage;
    }>>;
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
    status(appId: string, embedding?: BrainEmbeddingConfig): Promise<BrainStatus>;
    getDreamCursor(appId: string): Promise<BrainDreamCursor | null>;
    listPagesForDream(input: {
        appId: string;
        cursor?: BrainDreamCursor | null;
        limit: number;
    }): Promise<BrainPage[]>;
    saveDreamCursor(appId: string, cursor: BrainDreamCursor): Promise<void>;
    journalDreamDecision(input: BrainDreamDecisionWrite): Promise<void>;
    private pageBySlug;
}
export {};
