import { and, eq, inArray } from 'drizzle-orm';
import {
  SourceDocumentArtifactReceiptSchema,
  type RequestSourceAnswer,
} from '@gantry/contracts';
import * as s from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import { hash } from './source-answer-base.postgres.js';
import { SOURCE_DOCUMENT_CREATED_BY } from '../../../../source-documents/artifacts.js';
export async function assertSourceDocumentOutput(
  tx: CanonicalExecutor,
  input: {
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
  }
}
