import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  SourceDocumentArtifactReceiptSchema,
  type RequestSourceAnswer,
} from '@gantry/contracts';
import * as s from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import { hash } from './source-answer-base.postgres.js';
import {
  assertSourceDocumentCanonicalManifest,
  readSourceDocumentCanonical,
} from '../../../../source-documents/artifacts.js';
import { SOURCE_DOCUMENT_CREATED_BY } from '../../../../source-documents/artifacts.js';
export async function assertSourceDocumentOutput(
  tx: CanonicalExecutor,
  input: {
    answerId: string;
    conversationId: string;
    appId: string;
    agentId: string;
    sessionId: string;
    runId: string;
    request: RequestSourceAnswer;
    text: string;
  },
) {
  let output: unknown;
  try {
    output = JSON.parse(input.text);
  } catch {
    return;
  }
  if (
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output) ||
    !Object.hasOwn(output, 'artifacts')
  )
    return;
  const raw = (output as { artifacts: unknown }).artifacts;
  if (!Array.isArray(raw) || raw.length > 4)
    throw new Error('Invalid source document output manifest');
  const receipts = raw.map((row) =>
    SourceDocumentArtifactReceiptSchema.parse(row),
  );
  if (new Set(receipts.map((row) => row.artifactId)).size !== receipts.length)
    throw new Error('Duplicate source document output artifact');
  if (!receipts.length) return;
  const artifacts = await tx
    .select()
    .from(s.fileArtifactsPostgres)
    .where(
      and(
        eq(s.fileArtifactsPostgres.appId, input.appId),
        eq(s.fileArtifactsPostgres.agentId, input.agentId),
        inArray(
          s.fileArtifactsPostgres.id,
          receipts.map((row) => row.artifactId),
        ),
      ),
    );
  for (const receipt of receipts) {
    const artifact = artifacts.find((row) => row.id === receipt.artifactId);
    const metadata = artifact
      ? (JSON.parse(artifact.metadataJson) as {
          sourceDocument?: Record<string, unknown>;
          sourceDocumentCanonical?: unknown;
        })
      : undefined;
    if (
      !artifact ||
      artifact.deletedAt ||
      artifact.createdBy !== SOURCE_DOCUMENT_CREATED_BY ||
      artifact.sizeBytes !== receipt.sizeBytes ||
      artifact.contentHash !== `sha256:${receipt.sha256}` ||
      artifact.contentType !== receipt.contentType ||
      receipt.sessionId !== input.sessionId ||
      receipt.runId !== input.runId ||
      receipt.answerGoalId !== input.request.answerGoalId ||
      receipt.attemptId !== input.request.attemptId ||
      hash(receipt.binding) !== hash(input.request.binding) ||
      hash(receipt) !==
        hash({ ...metadata?.sourceDocument, artifactId: artifact.id })
    )
      throw new Error(
        'Source document output receipt does not belong to this answer',
      );
    if (receipt.canonicalContentHash) {
      const canonical = metadata!
        .sourceDocumentCanonical as import('../../../../source-documents/artifacts.js').SourceDocumentCanonical;
      assertSourceDocumentCanonicalManifest(receipt, canonical);
      if (canonical.revisionId !== input.request.revisionId)
        throw new Error('Document canonical revision mismatch');
      if (receipt.conversion) {
        const selected = await selectedSourceDocument(
          tx,
          {
            answerId: input.answerId,
            sessionId: input.sessionId,
            conversationId: input.conversationId,
            request: input.request,
            scope: { appId: input.appId, runId: input.runId },
          },
          receipt.conversion.artifactId,
        );
        if (
          hash(receipt.conversion) !==
          hash({
            artifactId: selected.receipt.artifactId,
            sourceMessageId: selected.sourceMessageId,
            sha256: selected.receipt.sha256,
            manifestHash: selected.receipt.manifestHash,
          })
        )
          throw new Error('Document conversion source proof mismatch');
        assertSourceDocumentCanonicalManifest(selected.receipt, canonical);
      }
    }
  }
}

import type { SourceLearningContext } from '../../../../domain/ports/source-learning.js';
import { sourceMessageArtifacts } from './source-message-artifacts.postgres.js';
import type { SourceDocumentArtifactReceipt } from '@gantry/contracts';
/** A supplied artifact ID is not authority; it must belong to an explicitly selected published source. */
export async function selectedSourceDocument(
  tx: CanonicalExecutor,
  context: Pick<
    SourceLearningContext,
    'answerId' | 'sessionId' | 'conversationId' | 'request'
  > & { scope: Pick<SourceLearningContext['scope'], 'appId' | 'runId'> },
  artifactId: string,
): Promise<{
  sourceMessageId: string;
  receipt: SourceDocumentArtifactReceipt;
}> {
  const [answer] = await tx
    .select()
    .from(s.pendingInteractionsPostgres)
    .where(
      and(
        eq(s.pendingInteractionsPostgres.id, context.answerId),
        eq(s.pendingInteractionsPostgres.appId, context.scope.appId),
        eq(s.pendingInteractionsPostgres.runId, context.scope.runId),
      ),
    );
  const selected =
    (
      answer?.payloadJson as
        | { contextSnapshot?: { selectedSourceIds?: string[] } }
        | undefined
    )?.contextSnapshot?.selectedSourceIds ?? [];
  if (
    answer?.status !== 'pending' ||
    !selected.length ||
    selected.length > 1000
  )
    throw new Error('Document conversion context is no longer active');
  const rows = await tx
    .select()
    .from(s.messagesPostgres)
    .where(
      and(
        eq(s.messagesPostgres.appId, context.scope.appId),
        eq(s.messagesPostgres.conversationId, context.conversationId),
        eq(
          s.messagesPostgres.sourceGeneration,
          context.request.binding.generation,
        ),
        inArray(s.messagesPostgres.sourceMessageId, selected),
      ),
    );
  const artifacts = await sourceMessageArtifacts(tx, {
    appId: context.scope.appId,
    sessionId: context.sessionId,
    binding: context.request.binding,
    messages: rows,
  });
  const matches = rows.flatMap((row) =>
    (artifacts.get(row.id) ?? [])
      .filter((receipt) => receipt.artifactId === artifactId)
      .map((receipt) => ({
        sourceMessageId: row.sourceMessageId!,
        receipt,
        position: row.sourcePosition,
      })),
  );
  if (
    matches.length !== 1 ||
    BigInt(String(matches[0]!.position)) > BigInt(context.request.sourceCutoff)
  )
    throw new Error(
      'Original document is outside the selected published conversation context',
    );
  const match = matches[0]!;
  const [origin] = await tx
    .select()
    .from(s.pendingInteractionsPostgres)
    .where(
      and(
        eq(s.pendingInteractionsPostgres.appId, context.scope.appId),
        eq(s.pendingInteractionsPostgres.runId, match.receipt.runId),
        sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType'='source_answer'`,
      ),
    );
  const originalRequest = (
    origin?.payloadJson as { request?: RequestSourceAnswer } | undefined
  )?.request;
  if (
    !originalRequest ||
    originalRequest.answerGoalId !== match.receipt.answerGoalId ||
    originalRequest.attemptId !== match.receipt.attemptId ||
    originalRequest.revisionId !== context.request.revisionId
  )
    throw new Error('Original document revision is not current');
  return { sourceMessageId: match.sourceMessageId, receipt: match.receipt };
}
