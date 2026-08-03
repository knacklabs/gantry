DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE (target_json ? 'recoveryIntent' AND target_json -> 'recoveryIntent' <> 'null'::jsonb)
       OR (target_json ? 'recovery_intent' AND target_json -> 'recovery_intent' <> 'null'::jsonb)
  ) THEN
    RAISE EXCEPTION 'jobs target_json contains non-null recovery intent';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "max_consecutive_failures" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "setup_state" jsonb;--> statement-breakpoint
UPDATE jobs
SET consecutive_failures = COALESCE(
      (target_json ->> 'consecutiveFailures')::integer,
      (target_json ->> 'consecutive_failures')::integer,
      0
    ),
    max_consecutive_failures = COALESCE(
      (target_json ->> 'maxConsecutiveFailures')::integer,
      (target_json ->> 'max_consecutive_failures')::integer
    ),
    pause_reason = COALESCE(
      target_json ->> 'pauseReason',
      target_json ->> 'pause_reason'
    ),
    setup_state = COALESCE(
      target_json -> 'setupState',
      target_json -> 'setup_state'
    ),
    target_json = target_json
      - 'consecutiveFailures'
      - 'consecutive_failures'
      - 'maxConsecutiveFailures'
      - 'max_consecutive_failures'
      - 'pauseReason'
      - 'pause_reason'
      - 'setupState'
      - 'setup_state'
      - 'recoveryIntent'
      - 'recovery_intent';
