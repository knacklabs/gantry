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
  new_id text;
BEGIN
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
      new_id :=
        'message-attachment:external:' || encoded_message_id || ':' || encoded_external_id;
    ELSE
      new_id :=
        'message-attachment:index:' || encoded_message_id || ':' || attachment_index;
    END IF;

    UPDATE message_attachments
    SET id = new_id,
        external_ref_json = CASE
          WHEN external_id IS NULL
          THEN jsonb_build_object('kind', 'message_attachment_index')
          ELSE external_ref_json
        END
    WHERE id = attachment_row.id;
  END LOOP;
END $$;
