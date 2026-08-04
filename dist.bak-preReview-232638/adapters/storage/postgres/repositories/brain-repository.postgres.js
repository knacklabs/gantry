import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { brainContentHash, brainEmbeddingText, normalizeEntityName, } from '../../../../brain/brain-page-ingest.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';
import { getBrainDreamCursor, journalBrainDreamDecision, listBrainPagesForDream, saveBrainDreamCursor, } from './brain-dream-repository.postgres.js';
const Pages = pgSchema.brainPagesPostgres;
const Entities = pgSchema.brainEntitiesPostgres;
const Edges = pgSchema.brainEdgesPostgres;
const Embeddings = pgSchema.brainPageEmbeddingsPostgres;
const DreamDecisions = pgSchema.brainDreamDecisionsPostgres;
export class PostgresBrainRepository {
    db;
    constructor(db) {
        this.db = db;
    }
    async getPageBySlug(appId, slug) {
        return this.pageBySlug(appId, slug);
    }
    async upsertPage(input) {
        const existing = await this.pageBySlug(input.appId, input.slug);
        const stamp = nowIso();
        const [row] = await this.db
            .insert(Pages)
            .values({
            id: `brp_${randomUUID().replace(/-/g, '')}`,
            appId: input.appId,
            slug: input.slug,
            title: input.title,
            markdown: input.markdown,
            sourceKind: input.sourceKind,
            sourceRef: input.sourceRef ?? null,
            authorId: input.authorId ?? null,
            metadataJson: input.metadata ?? {},
            createdAt: stamp,
            updatedAt: stamp,
        })
            .onConflictDoUpdate({
            target: [Pages.appId, Pages.slug],
            set: {
                title: input.title,
                markdown: input.markdown,
                sourceKind: input.sourceKind,
                sourceRef: input.sourceRef ?? null,
                authorId: input.authorId ?? null,
                metadataJson: input.metadata ?? {},
                updatedAt: stamp,
            },
        })
            .returning();
        return { page: toPage(row), created: !existing };
    }
    async getEntityByName(appId, kind, normalizedName) {
        const [row] = await this.db
            .select()
            .from(Entities)
            .where(and(eq(Entities.appId, appId), eq(Entities.kind, kind), eq(Entities.normalizedName, normalizedName)))
            .limit(1);
        return row ? toEntity(row) : null;
    }
    async upsertEntities(appId, entities) {
        const unique = new Map();
        for (const entity of entities) {
            if (!entity.normalizedName)
                continue;
            unique.set(`${entity.kind}:${entity.normalizedName}`, entity);
        }
        const out = [];
        for (const entity of unique.values()) {
            const stamp = nowIso();
            const [row] = await this.db
                .insert(Entities)
                .values({
                id: `bre_${randomUUID().replace(/-/g, '')}`,
                appId,
                kind: entity.kind,
                name: entity.name,
                normalizedName: entity.normalizedName,
                createdAt: stamp,
                updatedAt: stamp,
            })
                .onConflictDoUpdate({
                target: [Entities.appId, Entities.kind, Entities.normalizedName],
                set: {
                    name: entity.name,
                    updatedAt: stamp,
                },
            })
                .returning();
            out.push(toEntity(row));
        }
        return out;
    }
    async replacePageEdges(appId, pageId, edges) {
        await this.db
            .delete(Edges)
            .where(and(eq(Edges.appId, appId), eq(Edges.evidencePageId, pageId)));
        const unique = new Map();
        for (const edge of edges) {
            unique.set(`${edge.type}:${edge.fromEntityId}:${edge.toEntityId}`, edge);
        }
        if (unique.size === 0)
            return [];
        const stamp = nowIso();
        const rows = await this.db
            .insert(Edges)
            .values([...unique.values()].map((edge) => ({
            id: `brg_${randomUUID().replace(/-/g, '')}`,
            appId,
            type: edge.type,
            fromEntityId: edge.fromEntityId,
            toEntityId: edge.toEntityId,
            evidencePageId: pageId,
            createdAt: stamp,
            updatedAt: stamp,
        })))
            .onConflictDoNothing()
            .returning();
        return rows.map(toEdge);
    }
    async getEdge(input) {
        const [row] = await this.db
            .select()
            .from(Edges)
            .where(and(eq(Edges.appId, input.appId), eq(Edges.type, input.type), eq(Edges.fromEntityId, input.fromEntityId), eq(Edges.toEntityId, input.toEntityId), eq(Edges.evidencePageId, input.evidencePageId)))
            .limit(1);
        return row ? toEdge(row) : null;
    }
    async upsertEdges(appId, pageId, edges) {
        const unique = new Map();
        for (const edge of edges) {
            unique.set(`${edge.type}:${edge.fromEntityId}:${edge.toEntityId}`, edge);
        }
        if (unique.size === 0)
            return [];
        const stamp = nowIso();
        const rows = await this.db
            .insert(Edges)
            .values([...unique.values()].map((edge) => ({
            id: `brg_${randomUUID().replace(/-/g, '')}`,
            appId,
            type: edge.type,
            fromEntityId: edge.fromEntityId,
            toEntityId: edge.toEntityId,
            evidencePageId: pageId,
            createdAt: stamp,
            updatedAt: stamp,
        })))
            .onConflictDoUpdate({
            target: [
                Edges.appId,
                Edges.type,
                Edges.fromEntityId,
                Edges.toEntityId,
                Edges.evidencePageId,
            ],
            set: { updatedAt: stamp },
        })
            .returning();
        return rows.map(toEdge);
    }
    async searchLexical(input) {
        const query = input.query.trim();
        const document = sql `to_tsvector('english', ${Pages.title} || ' ' || ${Pages.markdown})`;
        const searchQuery = sql `plainto_tsquery('english', ${query})`;
        const lexicalScore = query
            ? sql `ts_rank_cd(${document}, ${searchQuery})`
            : sql `0`;
        const rows = await this.db
            .select({
            page: Pages,
            score: lexicalScore,
        })
            .from(Pages)
            .where(and(eq(Pages.appId, input.appId), query ? sql `${document} @@ ${searchQuery}` : undefined))
            .orderBy(desc(lexicalScore), desc(Pages.updatedAt), asc(Pages.slug))
            .limit(Math.max(1, Math.min(input.limit, 100)));
        return rows.map((row) => ({
            page: toPage(row.page),
            score: Number(row.score || 0),
            lexicalScore: Number(row.score || 0),
            vectorScore: 0,
            reasons: row.score ? ['lexical'] : [],
        }));
    }
    async searchVector(input) {
        return this.db.transaction(async (tx) => {
            await tx.execute(sql `select set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.ef_search', '200', true)`);
            const distance = sql `${Embeddings.embedding} <=> ${toVectorLiteral(input.vector)}::vector`;
            const rows = await tx
                .select({
                page: Pages,
                distance,
                contentHash: Embeddings.contentHash,
            })
                .from(Embeddings)
                .innerJoin(Pages, eq(Embeddings.pageId, Pages.id))
                .where(and(eq(Pages.appId, input.appId), eq(Embeddings.provider, input.embedding.provider), eq(Embeddings.model, input.embedding.model), eq(Embeddings.dimensions, input.embedding.dimensions), eq(Embeddings.status, 'ready'), sql `${Embeddings.embedding} is not null`, sql `${Embeddings.contentHash} = ${pageContentHashSql()}`))
                .orderBy(asc(distance))
                .limit(Math.max(1, Math.min(input.limit, 100)));
            return rows.map((row) => ({
                page: toPage(row.page),
                score: Math.max(0, 1 - Number(row.distance || 0)),
                lexicalScore: 0,
                vectorScore: Math.max(0, 1 - Number(row.distance || 0)),
                reasons: ['semantic'],
            }));
        });
    }
    async graphForPages(appId, pageIds) {
        if (pageIds.length === 0)
            return { entities: [], edges: [] };
        const edges = (await this.db
            .select()
            .from(Edges)
            .where(and(eq(Edges.appId, appId), inArray(Edges.evidencePageId, pageIds)))).map(toEdge);
        if (edges.length === 0)
            return { entities: [], edges };
        const ids = [
            ...new Set(edges.flatMap((edge) => [edge.fromEntityId, edge.toEntityId])),
        ];
        const entities = (await this.db
            .select()
            .from(Entities)
            .where(and(eq(Entities.appId, appId), inArray(Entities.id, ids)))).map(toEntity);
        return { entities, edges };
    }
    async findPeopleWorkingAt(appId, companyName) {
        const [companyRow] = await this.db
            .select()
            .from(Entities)
            .where(and(eq(Entities.appId, appId), eq(Entities.kind, 'company'), eq(Entities.normalizedName, normalizeEntityName(companyName))))
            .limit(1);
        if (!companyRow)
            return [];
        const edgeRows = await this.db
            .select()
            .from(Edges)
            .where(and(eq(Edges.appId, appId), eq(Edges.type, 'works_at'), eq(Edges.toEntityId, companyRow.id)));
        if (edgeRows.length === 0)
            return [];
        const people = await this.db
            .select()
            .from(Entities)
            .where(and(eq(Entities.appId, appId), eq(Entities.kind, 'person'), inArray(Entities.id, edgeRows.map((edge) => edge.fromEntityId))));
        const pages = await this.db
            .select()
            .from(Pages)
            .where(and(eq(Pages.appId, appId), inArray(Pages.id, edgeRows.map((edge) => edge.evidencePageId))));
        const peopleById = new Map(people.map((row) => [row.id, toEntity(row)]));
        const pagesById = new Map(pages.map((row) => [row.id, toPage(row)]));
        const company = toEntity(companyRow);
        return edgeRows.flatMap((edge) => {
            const person = peopleById.get(edge.fromEntityId);
            const page = pagesById.get(edge.evidencePageId);
            return person && page ? [{ person, company, page }] : [];
        });
    }
    async writePageEmbedding(input) {
        const stamp = nowIso();
        await this.db
            .insert(Embeddings)
            .values({
            pageId: input.pageId,
            provider: input.embedding.provider,
            model: input.embedding.model,
            dimensions: input.embedding.dimensions,
            contentHash: input.contentHash,
            embeddingJson: JSON.stringify(input.vector),
            embedding: input.vector,
            status: 'ready',
            error: null,
            createdAt: stamp,
            updatedAt: stamp,
        })
            .onConflictDoUpdate({
            target: [
                Embeddings.pageId,
                Embeddings.provider,
                Embeddings.model,
                Embeddings.contentHash,
            ],
            set: {
                dimensions: input.embedding.dimensions,
                embeddingJson: JSON.stringify(input.vector),
                embedding: input.vector,
                status: 'ready',
                error: null,
                updatedAt: stamp,
            },
        });
        await this.db
            .delete(Embeddings)
            .where(and(eq(Embeddings.pageId, input.pageId), eq(Embeddings.provider, input.embedding.provider), eq(Embeddings.model, input.embedding.model), ne(Embeddings.contentHash, input.contentHash)));
    }
    async markPageEmbeddingError(input) {
        const stamp = nowIso();
        await this.db
            .insert(Embeddings)
            .values({
            pageId: input.pageId,
            provider: input.embedding.provider,
            model: input.embedding.model,
            dimensions: input.embedding.dimensions,
            contentHash: input.contentHash,
            embeddingJson: null,
            embedding: null,
            status: 'retryable_error',
            error: input.error,
            createdAt: stamp,
            updatedAt: stamp,
        })
            .onConflictDoUpdate({
            target: [
                Embeddings.pageId,
                Embeddings.provider,
                Embeddings.model,
                Embeddings.contentHash,
            ],
            set: {
                dimensions: input.embedding.dimensions,
                status: 'retryable_error',
                error: input.error,
                updatedAt: stamp,
            },
        });
    }
    async listPendingEmbeddingPages(input) {
        const rows = await this.db
            .select()
            .from(Pages)
            .where(and(eq(Pages.appId, input.appId), sql `not exists (
            select 1 from ${Embeddings}
            where ${Embeddings.pageId} = ${Pages.id}
              and ${Embeddings.provider} = ${input.embedding.provider}
              and ${Embeddings.model} = ${input.embedding.model}
              and ${Embeddings.dimensions} = ${input.embedding.dimensions}
              and ${Embeddings.contentHash} = ${pageContentHashSql()}
              and ${Embeddings.status} = 'ready'
              and ${Embeddings.embedding} is not null
          )`))
            .orderBy(asc(Pages.updatedAt), asc(Pages.slug))
            .limit(Math.max(1, Math.min(input.limit, 1000)));
        return rows.map((row) => {
            const page = toPage(row);
            return {
                page,
                contentHash: brainContentHash(page),
                text: brainEmbeddingText(page),
            };
        });
    }
    async status(appId, embedding) {
        const [pages, channelPages, dreamPages, entities, edges, decisions, ready] = await Promise.all([
            this.db
                .select({ count: sql `count(*)::int` })
                .from(Pages)
                .where(eq(Pages.appId, appId)),
            this.db
                .select({ count: sql `count(*)::int` })
                .from(Pages)
                .where(and(eq(Pages.appId, appId), eq(Pages.sourceKind, 'channel'))),
            this.db
                .select({ count: sql `count(*)::int` })
                .from(Pages)
                .where(and(eq(Pages.appId, appId), eq(Pages.sourceKind, 'dream'))),
            this.db
                .select({ count: sql `count(*)::int` })
                .from(Entities)
                .where(eq(Entities.appId, appId)),
            this.db
                .select({ count: sql `count(*)::int` })
                .from(Edges)
                .where(eq(Edges.appId, appId)),
            this.db
                .select({ count: sql `count(*)::int` })
                .from(DreamDecisions)
                .where(eq(DreamDecisions.appId, appId)),
            embedding
                ? this.db
                    .select({ count: sql `count(*)::int` })
                    .from(Embeddings)
                    .innerJoin(Pages, eq(Embeddings.pageId, Pages.id))
                    .where(and(eq(Pages.appId, appId), eq(Embeddings.provider, embedding.provider), eq(Embeddings.model, embedding.model), eq(Embeddings.dimensions, embedding.dimensions), eq(Embeddings.status, 'ready'), sql `${Embeddings.embedding} is not null`, sql `${Embeddings.contentHash} = ${pageContentHashSql()}`))
                : Promise.resolve([{ count: 0 }]),
        ]);
        const cursor = await this.getDreamCursor(appId);
        const pageCount = Number(pages[0]?.count ?? 0);
        const readyEmbeddings = Number(ready[0]?.count ?? 0);
        return {
            pages: pageCount,
            channelPages: Number(channelPages[0]?.count ?? 0),
            dreamPages: Number(dreamPages[0]?.count ?? 0),
            entities: Number(entities[0]?.count ?? 0),
            edges: Number(edges[0]?.count ?? 0),
            dreamDecisions: Number(decisions[0]?.count ?? 0),
            lastDreamCursor: cursor?.updatedAt ?? null,
            readyEmbeddings,
            pendingEmbeddings: embedding
                ? Math.max(0, pageCount - readyEmbeddings)
                : 0,
        };
    }
    async getDreamCursor(appId) {
        return getBrainDreamCursor(this.db, appId);
    }
    async listPagesForDream(input) {
        return listBrainPagesForDream(this.db, input);
    }
    async saveDreamCursor(appId, cursor) {
        await saveBrainDreamCursor(this.db, appId, cursor);
    }
    async journalDreamDecision(input) {
        await journalBrainDreamDecision(this.db, input);
    }
    async pageBySlug(appId, slug) {
        const [row] = await this.db
            .select()
            .from(Pages)
            .where(and(eq(Pages.appId, appId), eq(Pages.slug, slug)))
            .limit(1);
        return row ? toPage(row) : null;
    }
}
function pageContentHashSql() {
    return sql `encode(digest(${Pages.title} || E'\n' || ${Pages.markdown}, 'sha256'), 'hex')`;
}
function toVectorLiteral(vector) {
    return `[${vector.join(',')}]`;
}
function toPage(row) {
    return {
        id: row.id,
        appId: row.appId,
        slug: row.slug,
        title: row.title,
        markdown: row.markdown,
        sourceKind: row.sourceKind,
        sourceRef: row.sourceRef,
        authorId: row.authorId,
        metadata: row.metadataJson && typeof row.metadataJson === 'object'
            ? row.metadataJson
            : {},
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
function toEntity(row) {
    return {
        id: row.id,
        appId: row.appId,
        kind: row.kind,
        name: row.name,
        normalizedName: row.normalizedName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
function toEdge(row) {
    return {
        id: row.id,
        appId: row.appId,
        type: row.type,
        fromEntityId: row.fromEntityId,
        toEntityId: row.toEntityId,
        evidencePageId: row.evidencePageId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
