import { rebuildSourceGeneration } from './source-generation-rebuild.postgres.js';
import { lockSourceEventApp } from './source-channel-event-lock.postgres.js';
import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import type {
  RebuildSourceGeneration,
  RebuildSourceGenerationResponse,
  AppendSourceMessageRequest,
  AppendSourceMessageResponse,
  SourceBinding,
} from '@gantry/contracts';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
import * as schema from '../schema/schema.js';
import { ApplicationError } from '../../../../application/common/application-error.js';
import { sourceMessageHashInput } from '@gantry/contracts';

type SourceReceipt = AppendSourceMessageRequest['message'] & {
  generation?: number;
  idempotencyKey: string;
  persistedEventId: string;
};
const conflict = (message: string): never => {
  throw new ApplicationError('CONFLICT', message);
};

/** The transaction writes only canonical history and a storage receipt. No admission exists here. */
export class PostgresSourceChannelRepository {
  constructor(private readonly db: CanonicalDb) {}

  async rebuild(
    appId: string,
    sessionId: string,
    input: RebuildSourceGeneration,
  ): Promise<RebuildSourceGenerationResponse> {
    return rebuildSourceGeneration(this.db, appId, sessionId, input);
  }

  async append(
    appId: string,
    sessionId: string,
    input: AppendSourceMessageRequest,
  ): Promise<AppendSourceMessageResponse> {
    if (Date.parse(input.authority.expiresAt) <= Date.now())
      conflict('Source service authority expired');
    if (input.authority.kind !== 'service')
      conflict('Source replication requires bound service authority');
    if (
      createHash('sha256')
        .update(sourceMessageHashInput(input.message))
        .digest('hex') !== input.message.contentHash
    )
      conflict('Source message content hash mismatch');
    return this.db.transaction(async (tx) => {
      await lockSourceEventApp(tx, appId);
      const [session] = await tx
        .select()
        .from(schema.controlHttpSessionsPostgres)
        .where(
          and(
            eq(schema.controlHttpSessionsPostgres.sessionId, sessionId),
            eq(schema.controlHttpSessionsPostgres.appId, appId),
          ),
        )
        .for('update');
      if (!session)
        throw new ApplicationError('NOT_FOUND', 'Session not found');
      if (session.externalConversationId !== input.binding.discussionId)
        conflict('Source discussion differs from bound conversation');
      const ref = session.externalRefJson as Record<string, unknown>;
      const binding = ref.sourceBinding as SourceBinding | undefined;
      if (
        binding &&
        (binding.discussionId !== input.binding.discussionId ||
          binding.generation !== input.binding.generation ||
          binding.workspaceId !== input.binding.workspaceId ||
          binding.tenderId !== input.binding.tenderId)
      )
        conflict('Source binding or generation differs');
      const service = ref.sourceAuthority as
        | { authorityId: string; subject: string }
        | undefined;
      if (
        service &&
        (service.authorityId !== input.authority.authorityId ||
          service.subject !== input.authority.subject)
      )
        conflict('Source service authority differs');
      const [agentSession] = await tx
        .select({ status: schema.agentSessionsPostgres.status })
        .from(schema.agentSessionsPostgres)
        .where(eq(schema.agentSessionsPostgres.id, sessionId));
      if (agentSession?.status === 'archived') conflict('Session is archived');
      const rows = await tx
        .select({
          id: schema.messagesPostgres.id,
          ref: schema.messagesPostgres.externalRefJson,
        })
        .from(schema.messagesPostgres)
        .where(
          and(
            eq(schema.messagesPostgres.conversationId, session.conversationId),
            eq(
              schema.messagesPostgres.sourceGeneration,
              input.binding.generation,
            ),
            or(
              eq(
                schema.messagesPostgres.sourceMessageId,
                input.message.sourceMessageId,
              ),
              eq(
                schema.messagesPostgres.sourcePosition,
                BigInt(input.message.sourcePosition),
              ),
              eq(
                schema.messagesPostgres.sourceIdempotencyKey,
                input.idempotencyKey,
              ),
            ),
          ),
        );
      const sources = rows
        .map((row) => ({
          id: row.id,
          source: (row.ref as Record<string, unknown> | null)?.source as
            | SourceReceipt
            | undefined,
        }))
        .filter(
          (row): row is { id: string; source: SourceReceipt } => !!row.source,
        );
      const prior = sources.find(
        (row) => row.source.sourceMessageId === input.message.sourceMessageId,
      );
      const keyUsed = sources.find(
        (row) => row.source.idempotencyKey === input.idempotencyKey,
      );
      if (keyUsed && keyUsed !== prior)
        conflict('Source idempotency key reused for another message');
      if (prior && prior.source.contentHash !== input.message.contentHash)
        conflict('Source identity has conflicting immutable content');
      if (
        sources.some(
          (row) =>
            row.source.sourcePosition === input.message.sourcePosition &&
            row !== prior,
        )
      )
        conflict('Source position already belongs to another message');
      if (!binding && input.binding.generation !== 1 && !prior)
        conflict('Initial source generation must be 1');
      if (prior) {
        let contiguous = String(ref.sourceContiguousPosition ?? '0');
        if (
          !binding ||
          !service ||
          ref.sourceContiguousPosition === undefined
        ) {
          const result = await tx.execute<{ through: string }>(
            sql`WITH ordered AS (SELECT source_position,row_number() OVER (ORDER BY source_position) AS ordinal FROM ${schema.messagesPostgres} WHERE conversation_id=${session.conversationId} AND source_generation=${input.binding.generation}) SELECT COALESCE(MAX(source_position) FILTER (WHERE source_position=ordinal),0)::text AS through FROM ordered`,
          );
          contiguous = result.rows[0]!.through;
          await tx
            .update(schema.controlHttpSessionsPostgres)
            .set({
              externalRefJson: {
                ...ref,
                sourceBinding: input.binding,
                sourceContiguousPosition: contiguous,
                sourceAuthority: {
                  authorityId: input.authority.authorityId,
                  subject: input.authority.subject,
                },
              },
            })
            .where(eq(schema.controlHttpSessionsPostgres.sessionId, sessionId));
        }
        return receipt(prior.id, prior.source, true, contiguous);
      }
      const source = input.message;
      const messageId =
        source.origin === 'runtime_output' && input.binding.generation === 1
          ? source.runtimeOutputId
          : `source:${sessionId}:${input.binding.generation}:${source.sourceMessageId}`;
      if (!messageId) conflict('Runtime output id required');
      if (source.origin === 'runtime_output') {
        if (source.authorKind !== 'assistant' || !source.answerGoalId)
          conflict('Runtime output association required');
        const [output] = await tx
          .select()
          .from(schema.messagesPostgres)
          .where(
            and(
              eq(schema.messagesPostgres.id, source.runtimeOutputId!),
              eq(
                schema.messagesPostgres.conversationId,
                session.conversationId,
              ),
              eq(schema.messagesPostgres.direction, 'outbound'),
            ),
          );
        if (!output) conflict('Runtime output not found in discussion');
        const association = output!.externalRefJson as {
          sourceAnswerGoalId?: string;
          sourceRunId?: string;
        };
        if (
          association.sourceAnswerGoalId !== source.answerGoalId ||
          !association.sourceRunId
        )
          conflict('Runtime output goal association mismatch');

        const [completed] = await tx
          .select()
          .from(schema.runtimeEventsPostgres)
          .where(
            and(
              eq(schema.runtimeEventsPostgres.appId, appId),
              eq(schema.runtimeEventsPostgres.sessionId, sessionId),
              eq(
                schema.runtimeEventsPostgres.correlationId,
                source.answerGoalId!,
              ),
              eq(schema.runtimeEventsPostgres.eventType, 'run.completed'),
              eq(schema.runtimeEventsPostgres.runId, association.sourceRunId!),
            ),
          );
        if (!completed)
          conflict('Runtime output has no correlated terminal result');
        if (input.binding.generation > 1) {
          await tx.insert(schema.messagesPostgres).values({
            ...output!,
            id: messageId!,
            externalMessageId: `generation:${input.binding.generation}:${source.sourceMessageId}`,
            sourceGeneration: null,
            sourcePosition: null,
            sourceMessageId: null,
            sourceIdempotencyKey: null,
            sourceContentHash: null,
            externalRefJson: { ...association },
          });
          await tx.insert(schema.messagePartsPostgres).values({
            messageId: messageId!,
            ordinal: 0,
            kind: 'text',
            payloadJson: { text: source.text },
          });
        }
        await tx
          .update(schema.messagePartsPostgres)
          .set({ payloadJson: { text: source.text } })
          .where(
            and(
              eq(schema.messagePartsPostgres.messageId, messageId!),
              eq(schema.messagePartsPostgres.ordinal, 0),
            ),
          );
        await tx
          .update(schema.messagesPostgres)
          .set({ deliveryStatus: 'sent' })
          .where(eq(schema.messagesPostgres.id, messageId!));
      } else {
        if (
          source.authorKind === 'assistant' ||
          source.runtimeOutputId ||
          source.answerGoalId
        )
          conflict('Assistant source must reconcile runtime output');
        await tx.insert(schema.messagesPostgres).values({
          id: messageId!,
          appId,
          providerId: 'app',
          providerAccountId: `control:${appId}`,
          conversationId: session.conversationId,
          externalMessageId:
            input.binding.generation === 1
              ? source.sourceMessageId
              : `generation:${input.binding.generation}:${source.sourceMessageId}`,
          sourceGeneration: input.binding.generation,
          sourceIdempotencyKey: input.idempotencyKey,
          sourcePosition: BigInt(source.sourcePosition),
          sourceMessageId: source.sourceMessageId,
          sourceContentHash: source.contentHash,
          direction: 'inbound',
          senderUserId: source.authorId,
          senderDisplayName: source.authorDisplayName,
          trust: source.authorKind === 'system' ? 'system' : 'trusted',
          createdAt: source.createdAt,
          receivedAt: new Date().toISOString(),
          externalRefJson: {},
        });
        await tx.insert(schema.messagePartsPostgres).values({
          messageId: messageId!,
          ordinal: 0,
          kind: 'text',
          payloadJson: { text: source.text },
        });
      }
      const [event] = await tx
        .insert(schema.runtimeEventsPostgres)
        .values({
          appId,
          agentId: session.agentId,
          sessionId,
          conversationId: session.conversationId,
          eventType: 'source.message.stored',
          actor: 'sdk',
          payloadJson: JSON.stringify({
            sourceMessageId: source.sourceMessageId,
            sourcePosition: source.sourcePosition,
            generation: input.binding.generation,
            messageId,
          }),
        })
        .returning({ id: schema.runtimeEventsPostgres.eventId });
      const stored: SourceReceipt = {
        ...source,
        generation: input.binding.generation,
        idempotencyKey: input.idempotencyKey,
        persistedEventId: String(event!.id),
      };
      const { text: _text, ...metadata } = stored;
      await tx
        .update(schema.messagesPostgres)
        .set({
          sourceGeneration: input.binding.generation,
          sourceIdempotencyKey: input.idempotencyKey,
          sourcePosition: BigInt(source.sourcePosition),
          sourceMessageId: source.sourceMessageId,
          sourceContentHash: source.contentHash,
          externalRefJson: sql`COALESCE(${schema.messagesPostgres.externalRefJson}, '{}'::jsonb) || ${JSON.stringify({ id: source.sourceMessageId, chat_jid: `app:${appId}:${input.binding.discussionId}`, provider: 'app', external_message_id: source.sourceMessageId, reply_to_message_id: source.replyToSourceId, store_only: true, source: metadata })}::jsonb`,
        })
        .where(eq(schema.messagesPostgres.id, messageId!));
      const checkpoint = String(ref.sourceContiguousPosition ?? '0');
      const result = await tx.execute<{ through: string }>(sql`WITH ordered AS (
        SELECT source_position, row_number() OVER (ORDER BY source_position) AS ordinal
        FROM ${schema.messagesPostgres}
        WHERE conversation_id=${session.conversationId} AND source_generation=${input.binding.generation} AND source_position > ${checkpoint}::bigint
      ) SELECT COALESCE(MAX(source_position) FILTER (WHERE source_position = ${checkpoint}::bigint + ordinal), ${checkpoint}::bigint)::text AS through FROM ordered`);
      const through = result.rows[0]!.through;
      await tx
        .update(schema.controlHttpSessionsPostgres)
        .set({
          externalRefJson: {
            ...ref,
            sourceBinding: input.binding,
            sourceContiguousPosition: through,
            sourceAuthority: {
              authorityId: input.authority.authorityId,
              subject: input.authority.subject,
            },
          },
        })
        .where(eq(schema.controlHttpSessionsPostgres.sessionId, sessionId));
      return receipt(messageId!, stored, false, through);
    });
  }
}
function receipt(
  messageId: string,
  source: SourceReceipt,
  replayed: boolean,
  contiguousPosition: string,
): AppendSourceMessageResponse {
  return {
    stored: true,
    replayed,
    messageId,
    sourceMessageId: source.sourceMessageId,
    sourcePosition: source.sourcePosition,
    generation: source.generation ?? 1,
    persistedEventId: source.persistedEventId,
    contiguousPosition,
  };
}
