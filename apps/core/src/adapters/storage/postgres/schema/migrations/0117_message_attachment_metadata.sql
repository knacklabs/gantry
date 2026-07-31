ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "file_name" text;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "provider_fetch_json" jsonb;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "message_attachments" AS attachment
SET "provider_fetch_json" = jsonb_build_object(
  'provider', 'slack',
  'kind', 'file_id',
  'id', attachment."external_ref_json"->>'value'
)
FROM "messages" AS message
WHERE message."id" = attachment."message_id"
  AND message."provider" = 'slack'
  AND attachment."provider_fetch_json" IS NULL
  AND attachment."external_ref_json"->>'kind' = 'message_attachment'
  AND jsonb_typeof(attachment."external_ref_json"->'value') = 'string'
  AND NULLIF(btrim(attachment."external_ref_json"->>'value'), '') IS NOT NULL;--> statement-breakpoint
DO $$
DECLARE
  attachment_row record;
  attachment_index text;
  byte_index integer;
  byte_value integer;
  encoded_external_id text;
  encoded_message_id text;
  external_id text;
  input_bytes bytea;
  target_base_id text;
BEGIN
  CREATE TEMP TABLE message_attachment_0117_id_rewrite (
    old_id text PRIMARY KEY,
    base_id text NOT NULL,
    source_ordinal text NOT NULL,
    target_id text
  ) ON COMMIT DROP;

  FOR attachment_row IN
    SELECT id, message_id, external_ref_json
    FROM message_attachments
    WHERE left(id, length('message-attachment:' || message_id || ':')) =
          'message-attachment:' || message_id || ':'
      AND substring(
            id FROM length('message-attachment:' || message_id || ':') + 1
          ) ~ '^[0-9]+$'
  LOOP
    attachment_index := substring(
      attachment_row.id
      FROM length('message-attachment:' || attachment_row.message_id || ':') + 1
    );
    encoded_message_id := '';
    input_bytes := convert_to(attachment_row.message_id, 'UTF8');
    IF length(input_bytes) > 0 THEN
      FOR byte_index IN 0..length(input_bytes) - 1 LOOP
        byte_value := get_byte(input_bytes, byte_index);
        IF byte_value BETWEEN 48 AND 57
          OR byte_value BETWEEN 65 AND 90
          OR byte_value BETWEEN 97 AND 122
          OR byte_value IN (33, 39, 40, 41, 42, 45, 46, 95, 126)
        THEN
          encoded_message_id := encoded_message_id || chr(byte_value);
        ELSE
          encoded_message_id :=
            encoded_message_id || '%' || upper(lpad(to_hex(byte_value), 2, '0'));
        END IF;
      END LOOP;
    END IF;

    external_id := CASE
      WHEN attachment_row.external_ref_json->>'kind' = 'message_attachment'
        AND jsonb_typeof(attachment_row.external_ref_json->'value') = 'string'
      THEN attachment_row.external_ref_json->>'value'
      ELSE NULL
    END;
    IF external_id IS NOT NULL THEN
      encoded_external_id := '';
      input_bytes := convert_to(external_id, 'UTF8');
      IF length(input_bytes) > 0 THEN
        FOR byte_index IN 0..length(input_bytes) - 1 LOOP
          byte_value := get_byte(input_bytes, byte_index);
          IF byte_value BETWEEN 48 AND 57
            OR byte_value BETWEEN 65 AND 90
            OR byte_value BETWEEN 97 AND 122
            OR byte_value IN (33, 39, 40, 41, 42, 45, 46, 95, 126)
          THEN
            encoded_external_id := encoded_external_id || chr(byte_value);
          ELSE
            encoded_external_id :=
              encoded_external_id || '%' || upper(lpad(to_hex(byte_value), 2, '0'));
          END IF;
        END LOOP;
      END IF;
      target_base_id :=
        'message-attachment:external:' || encoded_message_id || ':' || encoded_external_id;
    ELSE
      target_base_id :=
        'message-attachment:index:' || encoded_message_id || ':' || attachment_index;
    END IF;

    INSERT INTO message_attachment_0117_id_rewrite (
      old_id,
      base_id,
      source_ordinal
    ) VALUES (
      attachment_row.id,
      target_base_id,
      attachment_index
    );
  END LOOP;

  WITH rewrite_groups AS (
    SELECT
      rewrite.base_id,
      count(*)::bigint AS rewrite_count,
      (
        SELECT count(*)::bigint
        FROM message_attachments AS existing
        WHERE existing.id = rewrite.base_id
          OR (
            left(existing.id, length(rewrite.base_id) + 1) = rewrite.base_id || ':'
            AND substring(existing.id FROM length(rewrite.base_id) + 2) ~ '^[0-9]+$'
          )
      ) AS occupied_count
    FROM message_attachment_0117_id_rewrite AS rewrite
    GROUP BY rewrite.base_id
  ), candidate_slots AS (
    SELECT
      rewrite_group.base_id,
      slot.ordinal,
      CASE
        WHEN slot.ordinal = 1 THEN rewrite_group.base_id
        ELSE rewrite_group.base_id || ':' || slot.ordinal::text
      END AS candidate_id
    FROM rewrite_groups AS rewrite_group
    CROSS JOIN LATERAL generate_series(
      1::bigint,
      rewrite_group.rewrite_count + rewrite_group.occupied_count
    ) AS slot(ordinal)
  ), available_slots AS (
    SELECT
      candidate.base_id,
      candidate.candidate_id,
      row_number() OVER (
        PARTITION BY candidate.base_id
        ORDER BY candidate.ordinal
      ) AS occurrence_ordinal
    FROM candidate_slots AS candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM message_attachments AS existing
      WHERE existing.id = candidate.candidate_id
    )
  ), ranked_rewrites AS (
    SELECT
      rewrite.old_id,
      rewrite.base_id,
      row_number() OVER (
        PARTITION BY rewrite.base_id
        ORDER BY length(rewrite.source_ordinal), rewrite.source_ordinal, rewrite.old_id
      ) AS occurrence_ordinal
    FROM message_attachment_0117_id_rewrite AS rewrite
  )
  UPDATE message_attachment_0117_id_rewrite AS rewrite
  SET target_id = available.candidate_id
  FROM ranked_rewrites AS ranked
  JOIN available_slots AS available
    ON available.base_id = ranked.base_id
   AND available.occurrence_ordinal = ranked.occurrence_ordinal
  WHERE rewrite.old_id = ranked.old_id;

  UPDATE message_attachments AS attachment
  SET id = rewrite.target_id,
      external_ref_json = CASE
        WHEN attachment.external_ref_json->>'kind' = 'message_attachment'
          AND jsonb_typeof(attachment.external_ref_json->'value') = 'string'
        THEN attachment.external_ref_json
        ELSE jsonb_build_object('kind', 'message_attachment_index')
      END
  FROM message_attachment_0117_id_rewrite AS rewrite
  WHERE attachment.id = rewrite.old_id;
END $$;
