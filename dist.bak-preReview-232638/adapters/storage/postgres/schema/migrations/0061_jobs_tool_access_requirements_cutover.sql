-- Rename scheduler job requiredTools target metadata to toolAccessRequirements.
-- This is an access-preflight-only cutover: the old key represented confusing
-- post-run must-use semantics and is intentionally not retained.

DO $$
DECLARE
  rows_updated integer;
BEGIN
  LOOP
    WITH batch AS (
      SELECT ctid
      FROM jobs
      WHERE target_json ? 'requiredTools'
      LIMIT 10000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET target_json =
      CASE
        WHEN target_json ? 'toolAccessRequirements'
          THEN target_json - 'requiredTools'
        ELSE jsonb_set(
          target_json - 'requiredTools',
          '{toolAccessRequirements}',
          COALESCE(target_json -> 'requiredTools', '[]'::jsonb),
          true
        )
      END
    WHERE ctid IN (SELECT ctid FROM batch);

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;
