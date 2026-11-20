import { and, eq, inArray } from 'drizzle-orm';
import {
  SourceDocumentArtifactReceiptSchema,
  type SourceBinding,
  type SourceDocumentArtifactReceipt,
} from '@gantry/contracts';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import * as s from '../schema/schema.js';
type SourceRow = typeof s.messagesPostgres.$inferSelect;
/** Only native fenced outputs can contribute file metadata; source text is never an artifact authority. */
export async function sourceMessageArtifacts(
  tx: CanonicalExecutor,
  input: {
    appId: string;
    sessionId: string;
    binding: SourceBinding;
    messages: SourceRow[];
  },
): Promise<Map<string, SourceDocumentArtifactReceipt[]>> {
  const eligible = input.messages.filter(
    (row) =>
      row.direction === 'outbound' &&
      typeof (row.externalRefJson as { sourceAnswerGoalId?: unknown })
        ?.sourceAnswerGoalId === 'string',
  );
  const missing = eligible.filter(
    (row) =>
      !Array.isArray(
        (row.externalRefJson as { sourceArtifacts?: unknown }).sourceArtifacts,
      ),
  );
  const goals = [
    ...new Set(
      missing.map(
        (row) =>
          (row.externalRefJson as { sourceAnswerGoalId: string })
            .sourceAnswerGoalId,
      ),
    ),
  ];
  const events = goals.length
    ? await tx
        .select()
        .from(s.runtimeEventsPostgres)
        .where(
          and(
            eq(s.runtimeEventsPostgres.appId, input.appId),
            eq(s.runtimeEventsPostgres.sessionId, input.sessionId),
            eq(s.runtimeEventsPostgres.eventType, 'session.message.outbound'),
            inArray(s.runtimeEventsPostgres.correlationId, goals),
          ),
        )
    : [];
  const parsedEvents = events.map((event) => ({
    ...event,
    payload:
      typeof event.payloadJson === 'string'
        ? JSON.parse(event.payloadJson)
        : event.payloadJson,
  }));
  const result = new Map<string, SourceDocumentArtifactReceipt[]>();
  for (const row of eligible) {
    const ref = row.externalRefJson as {
      sourceAnswerGoalId: string;
      sourceRunId: string;
      sourceArtifacts?: unknown;
    };
    let raw = ref.sourceArtifacts;
    if (!Array.isArray(raw)) {
      const originalId =
        (row.externalRefJson as { source?: { runtimeOutputId?: string } })
          .source?.runtimeOutputId ?? row.id;
      const event = parsedEvents.find(
        (event) =>
          event.runId === ref.sourceRunId &&
          event.correlationId === ref.sourceAnswerGoalId &&
          (event.payload as { runtimeOutputId?: string })?.runtimeOutputId ===
            originalId,
      );
      const payload = event?.payload as { text?: string } | undefined;
      try {
        raw = payload?.text ? JSON.parse(payload.text).artifacts : undefined;
      } catch {
        raw = undefined;
      }
    }
    if (!Array.isArray(raw) || raw.length > 4) continue;
    const artifacts = raw.map((value) =>
      SourceDocumentArtifactReceiptSchema.parse(value),
    );
    if (
      artifacts.some(
        (receipt) =>
          receipt.sessionId !== input.sessionId ||
          receipt.runId !== ref.sourceRunId ||
          receipt.answerGoalId !== ref.sourceAnswerGoalId ||
          receipt.binding.discussionId !== input.binding.discussionId ||
          receipt.binding.workspaceId !== input.binding.workspaceId ||
          receipt.binding.tenderId !== input.binding.tenderId,
      )
    )
      throw new Error('Source attachment ownership mismatch');
    if (
      new Set(artifacts.map((receipt) => receipt.artifactId)).size !==
      artifacts.length
    )
      throw new Error('Duplicate source attachment');
    result.set(row.id, artifacts);
  }
  return result;
}
