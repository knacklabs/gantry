DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE target_json #> '{executionContext,groupScope}' IS NOT NULL
       OR target_json #> '{executionContext,group_scope}' IS NOT NULL
       OR target_json ? 'groupScope'
       OR target_json ? 'group_scope'
  ) THEN
    RAISE EXCEPTION 'Migration 0071 cannot translate legacy job group execution scope. Recreate affected jobs with executionContext.workspaceKey before applying this migration.';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS idx_jobs_target_group_scope_updated;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_jobs_target_workspace_key_updated
  ON jobs (
    (target_json #>> '{executionContext,workspaceKey}'),
    updated_at DESC,
    created_at DESC
  );
