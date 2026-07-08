import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
  integer,
} from 'drizzle-orm/pg-core';

import { appsPostgres } from './apps.js';

export const brainPagesPostgres = pgTable(
  'brain_pages',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    markdown: text('markdown').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceRef: text('source_ref'),
    authorId: text('author_id'),
    metadataJson: jsonb('metadata_json')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    appSlugUnique: uniqueIndex('idx_brain_pages_app_slug_unique').on(
      table.appId,
      table.slug,
    ),
    updatedIdx: index('idx_brain_pages_app_updated').on(
      table.appId,
      table.updatedAt.desc(),
    ),
    searchIdx: index('idx_brain_pages_search').using(
      'gin',
      sql`to_tsvector('english', ${table.title} || ' ' || ${table.markdown})`,
    ),
  }),
);

export const brainEntitiesPostgres = pgTable(
  'brain_entities',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    appKindNameUnique: uniqueIndex(
      'idx_brain_entities_app_kind_name_unique',
    ).on(table.appId, table.kind, table.normalizedName),
    lookupIdx: index('idx_brain_entities_lookup').on(
      table.appId,
      table.kind,
      table.normalizedName,
    ),
  }),
);

export const brainEdgesPostgres = pgTable(
  'brain_edges',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    fromEntityId: text('from_entity_id')
      .notNull()
      .references(() => brainEntitiesPostgres.id, { onDelete: 'cascade' }),
    toEntityId: text('to_entity_id')
      .notNull()
      .references(() => brainEntitiesPostgres.id, { onDelete: 'cascade' }),
    evidencePageId: text('evidence_page_id')
      .notNull()
      .references(() => brainPagesPostgres.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pageIdx: index('idx_brain_edges_page').on(
      table.appId,
      table.evidencePageId,
    ),
    fromIdx: index('idx_brain_edges_from').on(table.appId, table.fromEntityId),
    toIdx: index('idx_brain_edges_to').on(table.appId, table.toEntityId),
    uniqueEdge: uniqueIndex('idx_brain_edges_unique').on(
      table.appId,
      table.type,
      table.fromEntityId,
      table.toEntityId,
      table.evidencePageId,
    ),
  }),
);

export const brainPageEmbeddingsPostgres = pgTable(
  'brain_page_embeddings',
  {
    pageId: text('page_id')
      .notNull()
      .references(() => brainPagesPostgres.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    embeddingJson: text('embedding_json'),
    embedding: vector('embedding', { dimensions: 1536 }),
    dimensions: integer('dimensions').notNull().default(1536),
    status: text('status').notNull().default('ready'),
    error: text('error'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.pageId, table.provider, table.model, table.contentHash],
      name: 'brain_page_embeddings_pk',
    }),
    statusIdx: index('idx_brain_page_embeddings_status').on(
      table.status,
      table.updatedAt.desc(),
    ),
    readyLookupIdx: index('idx_brain_page_embeddings_ready_lookup')
      .on(
        table.provider,
        table.model,
        table.dimensions,
        table.status,
        table.pageId,
      )
      .where(sql`status = 'ready' AND embedding IS NOT NULL`),
    hnswIdx: index('idx_brain_page_embeddings_hnsw')
      .using('hnsw', table.embedding.op('vector_cosine_ops'))
      .where(sql`status = 'ready' AND embedding IS NOT NULL`),
  }),
);

export const brainDreamStatePostgres = pgTable('brain_dream_state', {
  appId: text('app_id')
    .primaryKey()
    .references(() => appsPostgres.id, { onDelete: 'cascade' }),
  cursorUpdatedAt: timestamp('cursor_updated_at', {
    withTimezone: true,
    mode: 'string',
  }),
  cursorPageId: text('cursor_page_id'),
  updatedAt: timestamp('updated_at', {
    withTimezone: true,
    mode: 'string',
  }).notNull(),
});

export const brainDreamDecisionsPostgres = pgTable(
  'brain_dream_decisions',
  {
    id: text('id').primaryKey(),
    appId: text('app_id')
      .notNull()
      .references(() => appsPostgres.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull(),
    pageId: text('page_id').references(() => brainPagesPostgres.id, {
      onDelete: 'set null',
    }),
    opJson: jsonb('op_json').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
  },
  (table) => ({
    runIdx: index('idx_brain_dream_decisions_run').on(table.runId),
    appIdx: index('idx_brain_dream_decisions_app').on(
      table.appId,
      table.createdAt,
    ),
  }),
);
