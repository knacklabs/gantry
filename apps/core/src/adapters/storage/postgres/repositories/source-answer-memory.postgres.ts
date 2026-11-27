import { parseItemSource } from '../../../../memory/app-memory-canonical-codec.js';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { subjectIdFor } from '../../../../memory/app-memory-boundaries.js';
import { sourceChannelMemorySubject } from '../../../../memory/source-channel-memory-scope.js';
import { SourceAnswerSummaryRepository } from './source-answer-summary.postgres.js';
import * as s from '../schema/schema.js';
export class SourceAnswerMemoryRepository extends SourceAnswerSummaryRepository {
  async memoryContext(input: {
    answerId: string;
    appId: string;
    agentId: string;
    workspaceId: string;
    personId?: string;
  }) {
    const group = sourceChannelMemorySubject({ ...input, scope: 'group' });
    const personal = input.personId
      ? sourceChannelMemorySubject({ ...input, scope: 'user' })
      : undefined;
    const rows = await this.db
      .select()
      .from(s.memoryItemsPostgres)
      .where(
        and(
          eq(s.memoryItemsPostgres.appId, input.appId),
          eq(s.memoryItemsPostgres.agentId, input.agentId),
          eq(s.memoryItemsPostgres.status, 'active'),
          inArray(s.memoryItemsPostgres.kind, [
            'preference',
            'correction',
            'constraint',
          ]),
          sql`((${s.memoryItemsPostgres.subjectType} = 'group' AND ${s.memoryItemsPostgres.subjectId} = ${subjectIdFor(group)}) OR (${s.memoryItemsPostgres.subjectType} = 'user' AND ${s.memoryItemsPostgres.subjectId} = ${personal ? subjectIdFor(personal) : ''}))`,
        ),
      )
      .orderBy(desc(s.memoryItemsPostgres.updatedAt))
      .limit(24);
    const [answer] = await this.db
      .select()
      .from(s.pendingInteractionsPostgres)
      .where(eq(s.pendingInteractionsPostgres.id, input.answerId));
    if (answer)
      await this.db
        .update(s.pendingInteractionsPostgres)
        .set({
          payloadJson: {
            ...(answer.payloadJson as Record<string, unknown>),
            memoryVersions: rows.map((row) => ({
              id: row.id,
              updatedAt: row.updatedAt,
            })),
          },
        })
        .where(eq(s.pendingInteractionsPostgres.id, input.answerId));
    return rows.length
      ? 'Scoped workspace instructions and requester style. Apply only compatible general instructions. Never disclose preference records or treat these notes as tender evidence.\n' +
          rows
            .map((row) =>
              JSON.stringify({
                id: row.id,
                scope: row.subjectType,
                key: row.key,
                value: (row.valueJson as { value?: string }).value ?? '',
                version: parseItemSource(row).version,
              }),
            )
            .join('\n')
      : '';
  }
}
