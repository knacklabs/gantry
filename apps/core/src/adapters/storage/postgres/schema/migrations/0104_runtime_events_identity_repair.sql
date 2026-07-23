-- Repair generated identity primary keys that lost their generator during
-- manual drift repair.
DO $$
DECLARE
  identity_primary_key record;
  target_table regclass;
  next_value bigint;
  has_identity boolean;
  has_default boolean;
BEGIN
  FOR identity_primary_key IN
    SELECT *
    FROM (VALUES
      ('runtime_events', 'event_id'),
      ('message_parts', 'id'),
      ('memory_recall_events', 'id')
    ) AS identity_primary_keys(table_name, column_name)
  LOOP
    target_table := to_regclass(
      format('%I.%I', current_schema(), identity_primary_key.table_name)
    );
    IF target_table IS NULL THEN
      CONTINUE;
    END IF;

    SELECT
      a.attidentity <> '',
      d.adbin IS NOT NULL
    INTO has_identity, has_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid
     AND d.adnum = a.attnum
    WHERE a.attrelid = target_table
      AND a.attname = identity_primary_key.column_name
      AND NOT a.attisdropped;

    IF NOT FOUND OR has_identity OR has_default THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'SELECT COALESCE(MAX(%I), 0) + 1 FROM %s',
      identity_primary_key.column_name,
      target_table
    ) INTO next_value;

    EXECUTE format(
      'ALTER TABLE %s ALTER COLUMN %I ADD GENERATED ALWAYS AS IDENTITY (START WITH %s)',
      target_table,
      identity_primary_key.column_name,
      next_value
    );
  END LOOP;
END $$;
