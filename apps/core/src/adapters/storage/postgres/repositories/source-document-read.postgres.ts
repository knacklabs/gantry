import { and, eq, sql } from 'drizzle-orm';
import type {
  ReadSourceDocument,
  ReadSourceDocumentResponse,
} from '@gantry/contracts';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import {
  SourceAnswerRepositoryBase,
  hash,
  fail,
} from './source-answer-base.postgres.js';
import * as s from '../schema/schema.js';
import type { FileArtifactStore } from '../../../../domain/ports/file-artifact-store.js';
import { getRuntimeFileArtifactStore } from '../runtime-store.js';
import {
  sourceDocumentReceipt,
  verifySourceDocumentBytes,
} from '../../../../source-documents/artifacts.js';
class SourceDocumentSessionReader extends SourceAnswerRepositoryBase {
  bound(appId: string, sessionId: string, input: ReadSourceDocument) {
    return this.db.transaction((tx) =>
      this.session(tx, appId, sessionId, input.binding),
    );
  }
}
export async function readSourceDocumentForSession(
  db: CanonicalDb,
  appId: string,
  sessionId: string,
  input: ReadSourceDocument,
  store: FileArtifactStore = getRuntimeFileArtifactStore(),
): Promise<ReadSourceDocumentResponse> {
  // Session authorization and generation checks use the same canonical binding as source writes.
  const session = await new SourceDocumentSessionReader(db).bound(
    appId,
    sessionId,
    input,
  );
  const [answer] = await db
    .select()
    .from(s.pendingInteractionsPostgres)
    .where(
      and(
        eq(s.pendingInteractionsPostgres.appId, appId),
        sql`${s.pendingInteractionsPostgres.payloadJson}->>'interactionType'='source_answer'`,
        sql`${s.pendingInteractionsPostgres.payloadJson}->'request'->>'answerGoalId'=${input.answerGoalId}`,
        sql`${s.pendingInteractionsPostgres.payloadJson}->'request'->>'attemptId'=${input.attemptId}`,
      ),
    );
  const payload = answer?.payloadJson as
    | {
        generationInvalidated?: boolean;
        request?: { binding: unknown };
        state?: string;
      }
    | undefined;
  if (
    !answer ||
    !answer.runId ||
    !['pending', 'resolved'].includes(answer.status) ||
    payload?.generationInvalidated ||
    hash(payload?.request?.binding) !== hash(input.binding) ||
    !['running', 'completed'].includes(payload?.state ?? '')
  )
    fail('Source document answer is unavailable');
  const result = await store.readFileArtifact({
    appId,
    agentId: session.agentId,
    id: input.artifactId as never,
  });
  const receipt = sourceDocumentReceipt(result.artifact);
  if (
    receipt.sessionId !== sessionId ||
    receipt.runId !== answer!.runId ||
    receipt.answerGoalId !== input.answerGoalId ||
    receipt.attemptId !== input.attemptId ||
    hash(receipt.binding) !== hash(input.binding)
  )
    fail('Source document identity mismatch');
  return {
    receipt,
    bytesBase64: verifySourceDocumentBytes(receipt, result.content).toString(
      'base64',
    ),
  };
}
