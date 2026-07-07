import { and, asc, eq, gt, ne, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import type {
  BrainDreamCursor,
  BrainDreamDecisionWrite,
} from '../../../../brain/brain-repository.js';
import type { BrainPage } from '../../../../brain/brain-types.js';
import { nowIso } from '../../../../shared/time/datetime.js';
import * as pgSchema from '../schema/schema.js';

type Db = NodePgDatabase<typeof pgSchema>;

const Pages = pgSchema.brainPagesPostgres;
const DreamState = pgSchema.brainDreamStatePostgres;
const DreamDecisions = pgSchema.brainDreamDecisionsPostgres;

export async function getBrainDreamCursor(
  db: Db,
  appId: string,
): Promise<BrainDreamCursor | null> {
  const [row] = await db
    .select()
    .from(DreamState)
    .where(eq(DreamState.appId, appId))
    .limit(1);
  return row?.cursorUpdatedAt && row.cursorPageId
    ? { updatedAt: row.cursorUpdatedAt, pageId: row.cursorPageId }
    : null;
}

export async function listBrainPagesForDream(
  db: Db,
  input: { appId: string; cursor?: BrainDreamCursor | null; limit: number },
): Promise<BrainPage[]> {
  const cursorFilter = input.cursor
    ? or(
        gt(Pages.updatedAt, input.cursor.updatedAt),
        and(
          eq(Pages.updatedAt, input.cursor.updatedAt),
          gt(Pages.id, input.cursor.pageId),
        ),
      )
    : undefined;
  const rows = await db
    .select()
    .from(Pages)
    .where(
      and(
        eq(Pages.appId, input.appId),
        ne(Pages.sourceKind, 'dream'),
        cursorFilter,
      ),
    )
    .orderBy(asc(Pages.updatedAt), asc(Pages.id))
    .limit(Math.max(1, Math.min(input.limit, 100)));
  return rows.map(toPage);
}

export async function saveBrainDreamCursor(
  db: Db,
  appId: string,
  cursor: BrainDreamCursor,
): Promise<void> {
  const stamp = nowIso();
  await db
    .insert(DreamState)
    .values({
      appId,
      cursorUpdatedAt: cursor.updatedAt,
      cursorPageId: cursor.pageId,
      updatedAt: stamp,
    })
    .onConflictDoUpdate({
      target: DreamState.appId,
      set: {
        cursorUpdatedAt: cursor.updatedAt,
        cursorPageId: cursor.pageId,
        updatedAt: stamp,
      },
    });
}

export async function journalBrainDreamDecision(
  db: Db,
  input: BrainDreamDecisionWrite,
): Promise<void> {
  const stamp = nowIso();
  await db
    .insert(DreamDecisions)
    .values({
      id: input.id,
      appId: input.appId,
      runId: input.runId,
      pageId: input.pageId ?? null,
      opJson: input.op,
      outcome: input.outcome,
      reason: input.reason,
      createdAt: stamp,
      updatedAt: stamp,
    })
    .onConflictDoUpdate({
      target: DreamDecisions.id,
      set: {
        opJson: input.op,
        outcome: input.outcome,
        reason: input.reason,
        updatedAt: stamp,
      },
    });
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
