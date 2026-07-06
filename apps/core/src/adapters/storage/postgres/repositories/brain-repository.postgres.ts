import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import {
  brainContentHash,
  brainEmbeddingText,
  normalizeEntityName,
} from '../../../../brain/brain-page-ingest.js';
import type {
  BrainEdge,
  BrainEmbeddingConfig,
  BrainEntity,
  BrainGraph,
  BrainPage,
  BrainStatus,
} from '../../../../brain/brain-types.js';
import type {
  BrainEdgeWrite,
  BrainEntityWrite,
  BrainPageWrite,
  BrainPendingEmbeddingPage,
  BrainRankedPage,
  BrainRepository,
} from '../../../../brain/brain-repository.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';

type Db = NodePgDatabase<typeof pgSchema>;

const Pages = pgSchema.brainPagesPostgres;
const Entities = pgSchema.brainEntitiesPostgres;
const Edges = pgSchema.brainEdgesPostgres;
const Embeddings = pgSchema.brainPageEmbeddingsPostgres;

export class PostgresBrainRepository implements BrainRepository {
  constructor(private readonly db: Db) {}

  async upsertPage(
    input: BrainPageWrite,
  ): Promise<{ page: BrainPage; created: boolean }> {
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
    return { page: toPage(row!), created: !existing };
  }

  async upsertEntities(
    appId: string,
    entities: BrainEntityWrite[],
  ): Promise<BrainEntity[]> {
    const unique = new Map<string, BrainEntityWrite>();
    for (const entity of entities) {
      if (!entity.normalizedName) continue;
      unique.set(`${entity.kind}:${entity.normalizedName}`, entity);
    }
    const out: BrainEntity[] = [];
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
      out.push(toEntity(row!));
    }
    return out;
  }

  async replacePageEdges(
    appId: string,
    pageId: string,
    edges: BrainEdgeWrite[],
  ): Promise<BrainEdge[]> {
    await this.db
      .delete(Edges)
      .where(and(eq(Edges.appId, appId), eq(Edges.evidencePageId, pageId)));
    const unique = new Map<string, BrainEdgeWrite>();
    for (const edge of edges) {
      unique.set(`${edge.type}:${edge.fromEntityId}:${edge.toEntityId}`, edge);
    }
    if (unique.size === 0) return [];
    const stamp = nowIso();
    const rows = await this.db
      .insert(Edges)
      .values(
        [...unique.values()].map((edge) => ({
          id: `brg_${randomUUID().replace(/-/g, '')}`,
          appId,
          type: edge.type,
          fromEntityId: edge.fromEntityId,
          toEntityId: edge.toEntityId,
          evidencePageId: pageId,
          createdAt: stamp,
          updatedAt: stamp,
        })),
      )
      .onConflictDoNothing()
      .returning();
    return rows.map(toEdge);
  }

  async searchLexical(input: {
    appId: string;
    query: string;
    limit: number;
  }): Promise<BrainRankedPage[]> {
    const query = input.query.trim();
    const document = sql`to_tsvector('english', ${Pages.title} || ' ' || ${Pages.markdown})`;
    const searchQuery = sql`plainto_tsquery('english', ${query})`;
    const lexicalScore = query
      ? sql<number>`ts_rank_cd(${document}, ${searchQuery})`
      : sql<number>`0`;
    const rows = await this.db
      .select({
        page: Pages,
        score: lexicalScore,
      })
      .from(Pages)
      .where(
        and(
          eq(Pages.appId, input.appId),
          query ? sql`${document} @@ ${searchQuery}` : undefined,
        ),
      )
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

  async searchVector(input: {
    appId: string;
    vector: number[];
    embedding: BrainEmbeddingConfig;
    limit: number;
  }): Promise<BrainRankedPage[]> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('hnsw.iterative_scan', 'strict_order', true), set_config('hnsw.ef_search', '200', true)`,
      );
      const distance = sql<number>`${Embeddings.embedding} <=> ${toVectorLiteral(input.vector)}::vector`;
      const rows = await tx
        .select({
          page: Pages,
          distance,
          contentHash: Embeddings.contentHash,
        })
        .from(Embeddings)
        .innerJoin(Pages, eq(Embeddings.pageId, Pages.id))
        .where(
          and(
            eq(Pages.appId, input.appId),
            eq(Embeddings.provider, input.embedding.provider),
            eq(Embeddings.model, input.embedding.model),
            eq(Embeddings.dimensions, input.embedding.dimensions),
            eq(Embeddings.status, 'ready'),
            sql`${Embeddings.embedding} is not null`,
            sql`${Embeddings.contentHash} = ${pageContentHashSql()}`,
          ),
        )
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

  async graphForPages(appId: string, pageIds: string[]): Promise<BrainGraph> {
    if (pageIds.length === 0) return { entities: [], edges: [] };
    const edges = (
      await this.db
        .select()
        .from(Edges)
        .where(
          and(eq(Edges.appId, appId), inArray(Edges.evidencePageId, pageIds)),
        )
    ).map(toEdge);
    if (edges.length === 0) return { entities: [], edges };
    const ids = [
      ...new Set(edges.flatMap((edge) => [edge.fromEntityId, edge.toEntityId])),
    ];
    const entities = (
      await this.db
        .select()
        .from(Entities)
        .where(and(eq(Entities.appId, appId), inArray(Entities.id, ids)))
    ).map(toEntity);
    return { entities, edges };
  }

  async findPeopleWorkingAt(
    appId: string,
    companyName: string,
  ): Promise<
    Array<{ person: BrainEntity; company: BrainEntity; page: BrainPage }>
  > {
    const [companyRow] = await this.db
      .select()
      .from(Entities)
      .where(
        and(
          eq(Entities.appId, appId),
          eq(Entities.kind, 'company'),
          eq(Entities.normalizedName, normalizeEntityName(companyName)),
        ),
      )
      .limit(1);
    if (!companyRow) return [];
    const edgeRows = await this.db
      .select()
      .from(Edges)
      .where(
        and(
          eq(Edges.appId, appId),
          eq(Edges.type, 'works_at'),
          eq(Edges.toEntityId, companyRow.id),
        ),
      );
    if (edgeRows.length === 0) return [];
    const people = await this.db
      .select()
      .from(Entities)
      .where(
        and(
          eq(Entities.appId, appId),
          eq(Entities.kind, 'person'),
          inArray(
            Entities.id,
            edgeRows.map((edge) => edge.fromEntityId),
          ),
        ),
      );
    const pages = await this.db
      .select()
      .from(Pages)
      .where(
        and(
          eq(Pages.appId, appId),
          inArray(
            Pages.id,
            edgeRows.map((edge) => edge.evidencePageId),
          ),
        ),
      );
    const peopleById = new Map(people.map((row) => [row.id, toEntity(row)]));
    const pagesById = new Map(pages.map((row) => [row.id, toPage(row)]));
    const company = toEntity(companyRow);
    return edgeRows.flatMap((edge) => {
      const person = peopleById.get(edge.fromEntityId);
      const page = pagesById.get(edge.evidencePageId);
      return person && page ? [{ person, company, page }] : [];
    });
  }

  async writePageEmbedding(input: {
    pageId: string;
    embedding: BrainEmbeddingConfig;
    contentHash: string;
    vector: number[];
  }): Promise<void> {
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
      .where(
        and(
          eq(Embeddings.pageId, input.pageId),
          eq(Embeddings.provider, input.embedding.provider),
          eq(Embeddings.model, input.embedding.model),
          ne(Embeddings.contentHash, input.contentHash),
        ),
      );
  }

  async markPageEmbeddingError(input: {
    pageId: string;
    embedding: BrainEmbeddingConfig;
    contentHash: string;
    error: string;
  }): Promise<void> {
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

  async listPendingEmbeddingPages(input: {
    appId: string;
    embedding: BrainEmbeddingConfig;
    limit: number;
  }): Promise<BrainPendingEmbeddingPage[]> {
    const rows = await this.db
      .select()
      .from(Pages)
      .where(
        and(
          eq(Pages.appId, input.appId),
          sql`not exists (
            select 1 from ${Embeddings}
            where ${Embeddings.pageId} = ${Pages.id}
              and ${Embeddings.provider} = ${input.embedding.provider}
              and ${Embeddings.model} = ${input.embedding.model}
              and ${Embeddings.dimensions} = ${input.embedding.dimensions}
              and ${Embeddings.contentHash} = ${pageContentHashSql()}
              and ${Embeddings.status} = 'ready'
              and ${Embeddings.embedding} is not null
          )`,
        ),
      )
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

  async status(
    appId: string,
    embedding?: BrainEmbeddingConfig,
  ): Promise<BrainStatus> {
    const [pages, entities, edges, ready] = await Promise.all([
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(Pages)
        .where(eq(Pages.appId, appId)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(Entities)
        .where(eq(Entities.appId, appId)),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(Edges)
        .where(eq(Edges.appId, appId)),
      embedding
        ? this.db
            .select({ count: sql<number>`count(*)::int` })
            .from(Embeddings)
            .innerJoin(Pages, eq(Embeddings.pageId, Pages.id))
            .where(
              and(
                eq(Pages.appId, appId),
                eq(Embeddings.provider, embedding.provider),
                eq(Embeddings.model, embedding.model),
                eq(Embeddings.dimensions, embedding.dimensions),
                eq(Embeddings.status, 'ready'),
                sql`${Embeddings.embedding} is not null`,
                sql`${Embeddings.contentHash} = ${pageContentHashSql()}`,
              ),
            )
        : Promise.resolve([{ count: 0 }]),
    ]);
    const pageCount = Number(pages[0]?.count ?? 0);
    const readyEmbeddings = Number(ready[0]?.count ?? 0);
    return {
      pages: pageCount,
      entities: Number(entities[0]?.count ?? 0),
      edges: Number(edges[0]?.count ?? 0),
      readyEmbeddings,
      pendingEmbeddings: embedding
        ? Math.max(0, pageCount - readyEmbeddings)
        : 0,
    };
  }

  private async pageBySlug(
    appId: string,
    slug: string,
  ): Promise<BrainPage | null> {
    const [row] = await this.db
      .select()
      .from(Pages)
      .where(and(eq(Pages.appId, appId), eq(Pages.slug, slug)))
      .limit(1);
    return row ? toPage(row) : null;
  }
}

function pageContentHashSql() {
  return sql`encode(digest(${Pages.title} || E'\n' || ${Pages.markdown}, 'sha256'), 'hex')`;
}

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

function toPage(row: typeof Pages.$inferSelect): BrainPage {
  return {
    id: row.id,
    appId: row.appId,
    slug: row.slug,
    title: row.title,
    markdown: row.markdown,
    sourceKind: row.sourceKind as BrainPage['sourceKind'],
    sourceRef: row.sourceRef,
    authorId: row.authorId,
    metadata:
      row.metadataJson && typeof row.metadataJson === 'object'
        ? (row.metadataJson as Record<string, unknown>)
        : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEntity(row: typeof Entities.$inferSelect): BrainEntity {
  return {
    id: row.id,
    appId: row.appId,
    kind: row.kind as BrainEntity['kind'],
    name: row.name,
    normalizedName: row.normalizedName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toEdge(row: typeof Edges.$inferSelect): BrainEdge {
  return {
    id: row.id,
    appId: row.appId,
    type: row.type as BrainEdge['type'],
    fromEntityId: row.fromEntityId,
    toEntityId: row.toEntityId,
    evidencePageId: row.evidencePageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
