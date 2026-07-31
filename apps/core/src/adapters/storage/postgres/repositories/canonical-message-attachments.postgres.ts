import { eq, sql } from 'drizzle-orm';

import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import { isProviderAttachmentStorageRef } from '../../../../shared/provider-attachment-materialization.js';
import * as pgSchema from '../schema/schema.js';
import {
  type CanonicalExecutor,
  jsonb,
} from './canonical-graph-repository.postgres.js';
import { lockCanonicalMessageAttachments } from './canonical-message-attachment-lock.postgres.js';
import {
  type RemovedProviderAttachment,
  storageRefForAttachmentWriter,
} from './provider-attachment-cleanup.postgres.js';

const MAX_MESSAGE_ATTACHMENTS_PER_ROW = 20;
const IDENTITYLESS_ATTACHMENT_ROW_ID_PREFIX = 'message-attachment:index:';
const IDENTITYLESS_ATTACHMENT_REF_KIND = 'message_attachment_index';

type IncomingMessageAttachment = NonNullable<NewMessage['attachments']>[number];

function providerFetchIdentity(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return typeof record.provider === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.id === 'string'
    ? JSON.stringify([record.provider, record.kind, record.id])
    : undefined;
}

function attachmentIdentityComponent(value: string): string {
  return encodeURIComponent(value);
}

function attachmentHasStableIdentity(
  attachment: IncomingMessageAttachment,
): boolean {
  return Boolean(
    attachment.id ||
    attachment.externalId ||
    providerFetchIdentity(attachment.provider_fetch),
  );
}

export function attachmentIdForIncomingAttachment(
  messageId: string,
  attachment: IncomingMessageAttachment,
  index: number,
): string {
  if (attachment.id) return attachment.id;
  if (attachment.externalId) {
    return `message-attachment:external:${attachmentIdentityComponent(messageId)}:${attachmentIdentityComponent(attachment.externalId)}`;
  }
  const providerFetch = attachment.provider_fetch;
  if (providerFetchIdentity(providerFetch) && providerFetch) {
    return `message-attachment:provider-fetch:${attachmentIdentityComponent(messageId)}:${attachmentIdentityComponent(providerFetch.provider)}:${attachmentIdentityComponent(providerFetch.kind)}:${attachmentIdentityComponent(providerFetch.id)}`;
  }
  return `${IDENTITYLESS_ATTACHMENT_ROW_ID_PREFIX}${attachmentIdentityComponent(messageId)}:${index}`;
}

export function attachmentExternalRefForIncomingAttachment(
  attachment: IncomingMessageAttachment,
): Record<string, string> | null {
  if (attachment.externalId) {
    return {
      kind: 'message_attachment',
      value: attachment.externalId,
    };
  }
  return attachmentHasStableIdentity(attachment)
    ? null
    : { kind: IDENTITYLESS_ATTACHMENT_REF_KIND };
}

export function attachmentsJsonForMessage(messageId: unknown) {
  const a = pgSchema.messageAttachmentsPostgres;
  return sql<string | null>`(
    SELECT COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'id', CASE
              WHEN attachment_row.external_ref_kind = ${IDENTITYLESS_ATTACHMENT_REF_KIND}
                OR (
                  left(
                    attachment_row.id,
                    length(
                      'message-attachment:' || attachment_row.message_id || ':'
                    )
                  ) =
                    'message-attachment:' || attachment_row.message_id || ':'
                  AND substring(
                    attachment_row.id
                    FROM length(
                      'message-attachment:' || attachment_row.message_id || ':'
                    ) + 1
                  ) ~ '^[0-9]+$'
                )
              THEN NULL
              ELSE attachment_row.id
            END,
            'kind', attachment_row.kind,
            'contentType', attachment_row.content_type,
            'sizeBytes', attachment_row.size_bytes,
            'storageRef', attachment_row.storage_ref,
            'externalId', attachment_row.external_id,
            'file_name', attachment_row.file_name,
            'deleted_at', attachment_row.deleted_at
          )
        )
        ||
        CASE
          WHEN attachment_row.provider_fetch_json IS NULL THEN '{}'::jsonb
          ELSE jsonb_build_object(
            'provider_fetch', attachment_row.provider_fetch_json
          )
        END
        ORDER BY attachment_row.id
      ),
      '[]'::jsonb
    )::text
    FROM (
      SELECT
        ${a.id} AS id,
        ${a.messageId} AS message_id,
        ${a.kind} AS kind,
        ${a.contentType} AS content_type,
        ${a.sizeBytes} AS size_bytes,
        ${a.storageRef} AS storage_ref,
        ${a.fileName} AS file_name,
        ${a.providerFetchJson} AS provider_fetch_json,
        ${a.deletedAt} AS deleted_at,
        ${a.externalRefJson}->>'kind' AS external_ref_kind,
        CASE
          WHEN ${a.externalRefJson}->>'kind' = 'message_attachment'
          THEN ${a.externalRefJson}->>'value'
          ELSE NULL
        END AS external_id
      FROM ${a}
      WHERE ${a.messageId} = ${messageId}
      ORDER BY ${a.id}
      LIMIT ${MAX_MESSAGE_ATTACHMENTS_PER_ROW}
    ) attachment_row
  )`;
}

function externalAttachmentValue(value: unknown): string | undefined {
  const ref =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;
  if (!ref || typeof ref !== 'object') return undefined;
  const record = ref as Record<string, unknown>;
  return record.kind === 'message_attachment' &&
    typeof record.value === 'string'
    ? record.value
    : undefined;
}

export function existingAttachmentMetadataMaps(
  rows: Array<{
    id: string;
    externalRefJson: unknown;
    storageRef: string | null;
    fileName: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    providerFetchJson: unknown;
    deletedAt: string | null;
  }>,
) {
  type PreservedAttachmentMetadata = {
    id: string;
    externalId: string | undefined;
    externalRefJson: unknown;
    providerFetchIdentity: string | undefined;
    storageRef: string | null;
    fileName: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    providerFetchJson: unknown;
    deletedAt: string | null;
  };
  const byId = new Map<string, PreservedAttachmentMetadata>();
  const byExternalId = new Map<string, PreservedAttachmentMetadata>();
  const byProviderFetchIdentity = new Map<
    string,
    PreservedAttachmentMetadata
  >();
  for (const row of rows) {
    const externalId = externalAttachmentValue(row.externalRefJson);
    const metadata = {
      id: row.id,
      externalId,
      externalRefJson: row.externalRefJson,
      providerFetchIdentity: providerFetchIdentity(row.providerFetchJson),
      storageRef: row.storageRef,
      fileName: row.fileName,
      contentType: row.contentType ?? null,
      sizeBytes: row.sizeBytes ?? null,
      providerFetchJson: row.providerFetchJson,
      deletedAt: row.deletedAt,
    };
    byId.set(row.id, metadata);
    if (externalId) byExternalId.set(externalId, metadata);
    if (metadata.providerFetchIdentity) {
      byProviderFetchIdentity.set(metadata.providerFetchIdentity, metadata);
    }
  }
  return { byId, byExternalId, byProviderFetchIdentity };
}

export function providerAttachmentStorageRefsRemovedByReplacement(
  existingRows: Array<{ storageRef: string | null }>,
  replacementRows: Array<{ storageRef: string | null }>,
): string[] {
  const retainedRefs = new Set(
    replacementRows
      .map((row) => row.storageRef)
      .filter((storageRef): storageRef is string => Boolean(storageRef)),
  );
  return [
    ...new Set(
      existingRows
        .map((row) => row.storageRef)
        .filter(
          (storageRef): storageRef is string =>
            typeof storageRef === 'string' &&
            isProviderAttachmentStorageRef(storageRef) &&
            !retainedRefs.has(storageRef),
        ),
    ),
  ];
}

export async function replaceCanonicalMessageAttachments(
  tx: CanonicalExecutor,
  input: {
    messageId: string;
    incomingAttachments: IncomingMessageAttachment[];
    messageInserted: boolean;
    trust: 'system' | 'trusted';
  },
): Promise<RemovedProviderAttachment[]> {
  const { messageId, incomingAttachments, messageInserted, trust } = input;
  const attachmentMetadataColumns = {
    id: pgSchema.messageAttachmentsPostgres.id,
    externalRefJson: pgSchema.messageAttachmentsPostgres.externalRefJson,
    storageRef: pgSchema.messageAttachmentsPostgres.storageRef,
    fileName: pgSchema.messageAttachmentsPostgres.fileName,
    contentType: pgSchema.messageAttachmentsPostgres.contentType,
    sizeBytes: pgSchema.messageAttachmentsPostgres.sizeBytes,
    providerFetchJson: pgSchema.messageAttachmentsPostgres.providerFetchJson,
    deletedAt: pgSchema.messageAttachmentsPostgres.deletedAt,
  };
  if (!messageInserted) {
    await lockCanonicalMessageAttachments(tx, messageId);
  }
  const existingAttachmentRows = messageInserted
    ? []
    : incomingAttachments.length > 0
      ? await tx
          .select(attachmentMetadataColumns)
          .from(pgSchema.messageAttachmentsPostgres)
          .where(eq(pgSchema.messageAttachmentsPostgres.messageId, messageId))
      : await tx
          .delete(pgSchema.messageAttachmentsPostgres)
          .where(eq(pgSchema.messageAttachmentsPostgres.messageId, messageId))
          .returning(attachmentMetadataColumns);
  const existingAttachmentMetadata = existingAttachmentMetadataMaps(
    existingAttachmentRows,
  );
  const replacementAttachmentRows = incomingAttachments.map(
    (attachment, index) => {
      const attachmentId = attachmentIdForIncomingAttachment(
        messageId,
        attachment,
        index,
      );
      const preservedMetadata = preservedMetadataForIncomingAttachment(
        attachment,
        attachmentId,
        existingAttachmentMetadata,
      );
      return {
        id: preservedMetadata.attachmentId,
        messageId,
        kind: attachment.kind,
        contentType:
          attachment.contentType ?? preservedMetadata.contentType ?? null,
        sizeBytes: attachment.sizeBytes ?? preservedMetadata.sizeBytes ?? null,
        externalRefJson: preservedMetadata.externalRefJson
          ? jsonb(preservedMetadata.externalRefJson)
          : null,
        storageRef: preservedMetadata.storageRef,
        fileName: preservedMetadata.fileName,
        providerFetchJson: jsonb(preservedMetadata.providerFetchJson),
        deletedAt: preservedMetadata.deletedAt,
        trust,
      };
    },
  );
  const removedProviderStorageRefs =
    providerAttachmentStorageRefsRemovedByReplacement(
      existingAttachmentRows,
      replacementAttachmentRows,
    ).map((storageRef) => ({ messageId, storageRef }));
  if (!messageInserted && incomingAttachments.length > 0) {
    await tx
      .delete(pgSchema.messageAttachmentsPostgres)
      .where(eq(pgSchema.messageAttachmentsPostgres.messageId, messageId));
  }
  if (replacementAttachmentRows.length > 0) {
    await tx
      .insert(pgSchema.messageAttachmentsPostgres)
      .values(replacementAttachmentRows);
  }
  return removedProviderStorageRefs;
}

function mergedProviderFetch(
  incoming: IncomingMessageAttachment['provider_fetch'],
  stored: unknown,
): unknown {
  if (!incoming) return stored ?? null;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return incoming;
  }
  const storedRecord = stored as Record<string, unknown>;
  return storedRecord.provider === incoming.provider &&
    storedRecord.kind === incoming.kind &&
    storedRecord.id === incoming.id
    ? { ...storedRecord, ...incoming }
    : incoming;
}

export function preservedMetadataForIncomingAttachment(
  attachment: IncomingMessageAttachment,
  attachmentId: string,
  existingMetadata: ReturnType<typeof existingAttachmentMetadataMaps>,
) {
  const incomingProviderFetchIdentity = providerFetchIdentity(
    attachment.provider_fetch,
  );
  const idMatch = attachment.id
    ? existingMetadata.byId.get(attachmentId)
    : undefined;
  const externalIdMatch = attachment.externalId
    ? existingMetadata.byExternalId.get(attachment.externalId)
    : undefined;
  const providerFetchMatch = incomingProviderFetchIdentity
    ? existingMetadata.byProviderFetchIdentity.get(
        incomingProviderFetchIdentity,
      )
    : undefined;
  const conflicts = (candidate: typeof idMatch): boolean =>
    candidate !== undefined &&
    ((attachment.externalId !== undefined &&
      candidate.externalId !== undefined &&
      candidate.externalId !== attachment.externalId) ||
      (incomingProviderFetchIdentity !== undefined &&
        candidate.providerFetchIdentity !== undefined &&
        candidate.providerFetchIdentity !== incomingProviderFetchIdentity));
  const preserved = [idMatch, externalIdMatch, providerFetchMatch].find(
    (candidate) => candidate !== undefined && !conflicts(candidate),
  );
  const incomingExternalRef =
    attachmentExternalRefForIncomingAttachment(attachment);
  return {
    attachmentId: preserved?.id ?? attachmentId,
    externalRefJson:
      attachment.externalId !== undefined
        ? incomingExternalRef
        : (preserved?.externalRefJson ?? incomingExternalRef),
    storageRef: storageRefForAttachmentWriter(
      attachment.storageRef,
      preserved?.storageRef,
    ),
    fileName: attachment.file_name ?? preserved?.fileName ?? null,
    ...(attachment.contentType !== undefined ||
    typeof preserved?.contentType === 'string'
      ? {
          contentType: attachment.contentType ?? preserved?.contentType ?? null,
        }
      : {}),
    ...(attachment.sizeBytes !== undefined ||
    typeof preserved?.sizeBytes === 'number'
      ? {
          sizeBytes: attachment.sizeBytes ?? preserved?.sizeBytes ?? null,
        }
      : {}),
    providerFetchJson: mergedProviderFetch(
      attachment.provider_fetch,
      preserved?.providerFetchJson,
    ),
    deletedAt: attachment.deleted_at ?? preserved?.deletedAt ?? null,
  };
}
