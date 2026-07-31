import type {
  BrainEdge,
  BrainEntity,
  BrainPage,
} from '../../../../brain/brain-types.js';
import * as pgSchema from '../schema/schema.js';

// Row → domain mappers shared by the brain repository and its read helpers.
// Extracted so neither file carries all three plus the query surface.

export function toBrainPage(
  row: typeof pgSchema.brainPagesPostgres.$inferSelect,
): BrainPage {
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

export function toBrainEntity(
  row: typeof pgSchema.brainEntitiesPostgres.$inferSelect,
): BrainEntity {
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

export function toBrainEdge(
  row: typeof pgSchema.brainEdgesPostgres.$inferSelect,
): BrainEdge {
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
