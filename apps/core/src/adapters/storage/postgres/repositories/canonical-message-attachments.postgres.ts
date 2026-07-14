import { sql } from 'drizzle-orm';

import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import * as pgSchema from '../schema/schema.js';

const MAX_MESSAGE_ATTACHMENTS_PER_ROW = 20;

type IncomingMessageAttachment = NonNullable<NewMessage['attachments']>[number];

export function attachmentsJsonForMessage(messageId: unknown) {
  const a = pgSchema.messageAttachmentsPostgres;
  return sql<string | null>`(
    SELECT COALESCE(
      jsonb_agg(
        jsonb_strip_nulls(
          jsonb_build_object(
            'kind', attachment_row.kind,
            'contentType', attachment_row.content_type,
            'sizeBytes', attachment_row.size_bytes,
            'storageRef', attachment_row.storage_ref,
            'externalId', attachment_row.external_id
          )
        )
        ORDER BY attachment_row.id
      ),
      '[]'::jsonb
    )::text
    FROM (
      SELECT
        ${a.id} AS id,
        ${a.kind} AS kind,
        ${a.contentType} AS content_type,
        ${a.sizeBytes} AS size_bytes,
        ${a.storageRef} AS storage_ref,
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

export function existingAttachmentStorageMaps(
  rows: Array<{
    id: string;
    externalRefJson: unknown;
    storageRef: string | null;
  }>,
) {
  const byId = new Map<string, string>();
  const byExternalId = new Map<string, string>();
  for (const row of rows) {
    if (!row.storageRef) continue;
    byId.set(row.id, row.storageRef);
    const externalId = externalAttachmentValue(row.externalRefJson);
    if (externalId) byExternalId.set(externalId, row.storageRef);
  }
  return { byId, byExternalId };
}

export function storageRefForIncomingAttachment(
  attachment: IncomingMessageAttachment,
  attachmentId: string,
  existingStorageRefs: ReturnType<typeof existingAttachmentStorageMaps>,
): string | null {
  return (
    attachment.storageRef ??
    existingStorageRefs.byId.get(attachmentId) ??
    (attachment.externalId
      ? existingStorageRefs.byExternalId.get(attachment.externalId)
      : undefined) ??
    null
  );
}
