import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  sourceContextReceiptHashInput,
  SourceContextReceiptSchema,
  type SourceContextReceipt,
  type SourceContextSource,
  type RequestSourceAnswer,
} from '@gantry/contracts';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import * as s from '../schema/schema.js';
import { fail } from './source-answer-base.postgres.js';
export type ContextProofSnapshot = {
  selectionMode: 'recent' | 'ancestry';
  sources: SourceContextSource[];
};
export function contextReceiptFromSnapshot(
  request: RequestSourceAnswer,
  snapshot: ContextProofSnapshot,
  summary: SourceContextReceipt['summary'],
): SourceContextReceipt {
  const sources = [...snapshot.sources, ...(summary?.citedSources ?? [])];
  if (
    sources.some(
      (row) => BigInt(row.sourcePosition) > BigInt(request.sourceCutoff),
    ) ||
    new Set(snapshot.sources.map((row) => row.sourceMessageId)).size !==
      snapshot.sources.length
  )
    fail('Invalid selected source context proof');
  const body = {
    version: 1 as const,
    binding: request.binding,
    answerGoalId: request.answerGoalId,
    attemptId: request.attemptId,
    questionSourceId: request.questionSourceId,
    sourceCutoff: request.sourceCutoff,
    revisionId: request.revisionId,
    selectionMode: snapshot.selectionMode,
    sources: snapshot.sources,
    ...(summary ? { summary } : {}),
  };
  return SourceContextReceiptSchema.parse({
    ...body,
    receiptHash: createHash('sha256')
      .update(sourceContextReceiptHashInput(body))
      .digest('hex'),
  });
}
export async function buildSourceContextReceipt(
  tx: CanonicalExecutor,
  input: {
    request: RequestSourceAnswer;
    snapshot: ContextProofSnapshot;
    summaryId?: string;
    sessionId: string;
    conversationId: string;
    appId: string;
    text: string;
  },
) {
  let summary: SourceContextReceipt['summary'];
  let output: {
    answerUnits?: { source?: string; conversationSourceIds?: string[] }[];
  } = {};
  try {
    const parsed=JSON.parse(input.text);
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))output=parsed;
  } catch {
    /* Legacy source profiles may return plain text. */
  }
  const referenced = [
    ...new Set(
      (output.answerUnits ?? [])
        .filter((unit) => unit.source === 'conversation')
        .flatMap((unit) => unit.conversationSourceIds ?? []),
    ),
  ];
  if (referenced.length > 100) fail('Too many conversation references');
  if (input.summaryId) {
    const [digest] = await tx
      .select()
      .from(s.agentSessionDigestsPostgres)
      .where(
        and(
          eq(s.agentSessionDigestsPostgres.id, input.summaryId),
          eq(s.agentSessionDigestsPostgres.appId, input.appId),
          eq(s.agentSessionDigestsPostgres.agentSessionId, input.sessionId),
        ),
      );
    if (!digest) fail('Source context digest absent');
    const metadata = digest!.metadataJson as {
      generation: number;
      workspaceId: string;
      sourceVersion: string;
      coveredRange?: { after: string; through: string };
      coveredSourceIds?: string[];
    };
    if (
      metadata.generation !== input.request.binding.generation ||
      metadata.workspaceId !== input.request.binding.workspaceId ||
      metadata.sourceVersion !== input.request.revisionId
    )
      fail('Source context digest scope mismatch');
    const selected = new Set(
      input.snapshot.sources.map((row) => row.sourceMessageId),
    );
    const cited = referenced.filter((id) => !selected.has(id));
    if (cited.length > 100) fail('Too many summary conversation references');
    const rows = cited.length
      ? await tx
          .select()
          .from(s.messagesPostgres)
          .where(
            and(
              eq(s.messagesPostgres.conversationId, input.conversationId),
              eq(s.messagesPostgres.appId, input.appId),
              eq(
                s.messagesPostgres.sourceGeneration,
                input.request.binding.generation,
              ),
              inArray(s.messagesPostgres.sourceMessageId, cited),
            ),
          )
      : [];
    if (rows.length !== cited.length)
      fail('Unknown summarized source reference');
    const citedSources = rows.map((row) => {
      const position = String(row.sourcePosition);
      const covered =
        metadata.coveredSourceIds?.includes(row.sourceMessageId!) ||
        (metadata.coveredRange &&
          BigInt(position) > BigInt(metadata.coveredRange.after) &&
          BigInt(position) <= BigInt(metadata.coveredRange.through));
      if (!covered || !row.sourceContentHash)
        fail('Conversation reference was not in the selected digest');
      return {
        sourceMessageId: row.sourceMessageId!,
        sourcePosition: position,
        contentHash: row.sourceContentHash!,
      };
    });
    summary = {
      digestId: digest!.id,
      sha256: createHash('sha256').update(digest!.digest).digest('hex'),
      ...(metadata.coveredRange ? { coveredRange: metadata.coveredRange } : {}),
      ...(metadata.coveredSourceIds
        ? { coveredSourceIds: metadata.coveredSourceIds }
        : {}),
      citedSources,
    };
  }
  const allowed = new Set(
    [...input.snapshot.sources, ...(summary?.citedSources ?? [])].map(
      (source) => source.sourceMessageId,
    ),
  );
  if (referenced.some((id) => !allowed.has(id)))
    fail('Conversation reference was not selected for this answer');
  return contextReceiptFromSnapshot(input.request, input.snapshot, summary);
}
