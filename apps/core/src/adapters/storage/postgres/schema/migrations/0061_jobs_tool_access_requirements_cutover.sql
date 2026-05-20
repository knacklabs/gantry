-- Rename scheduler job requiredTools target metadata to toolAccessRequirements.
-- This is an access-preflight-only cutover: the old key represented confusing
-- post-run must-use semantics and is intentionally not retained.

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
WHERE target_json ? 'requiredTools';
