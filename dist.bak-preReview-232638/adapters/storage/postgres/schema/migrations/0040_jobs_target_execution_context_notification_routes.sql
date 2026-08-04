DO $$
DECLARE invalid_count bigint;
BEGIN
  SELECT count(*)
    INTO invalid_count
  FROM jobs
  WHERE COALESCE(NULLIF(target_json, '')::jsonb #>> '{executionContext,conversationJid}', '') = ''
    OR COALESCE(NULLIF(target_json, '')::jsonb #>> '{executionContext,groupScope}', '') = ''
    OR COALESCE(NULLIF(target_json, '')::jsonb ? 'linkedSessions', false)
    OR COALESCE(NULLIF(target_json, '')::jsonb ? 'threadId', false)
    OR COALESCE(NULLIF(target_json, '')::jsonb ? 'sessionId', false)
    OR COALESCE(NULLIF(target_json, '')::jsonb ? 'groupScope', false)
    OR (
      COALESCE(NULLIF(target_json, '')::jsonb ? 'notificationRoutes', false)
      AND jsonb_typeof(NULLIF(target_json, '')::jsonb -> 'notificationRoutes') <> 'array'
    );

  IF invalid_count > 0 THEN
    RAISE EXCEPTION 'jobs.target_json migration requires canonical executionContext/notificationRoutes and rejects legacy linkedSessions, threadId, sessionId, and groupScope route fields';
  END IF;
END $$;
--> statement-breakpoint

UPDATE jobs
SET target_json = (
  WITH normalized AS (
    SELECT COALESCE(NULLIF(jobs.target_json, '')::jsonb, '{}'::jsonb) AS target
  ),
  derived AS (
    SELECT
      normalized.target AS target,
      normalized.target #>> '{executionContext,conversationJid}' AS conversation_jid,
      normalized.target #>> '{executionContext,groupScope}' AS group_scope,
      COALESCE(
        normalized.target #> '{executionContext,threadId}',
        'null'::jsonb
      ) AS thread_id_json,
      COALESCE(
        normalized.target #> '{executionContext,sessionId}',
        'null'::jsonb
      ) AS session_id_json,
      CASE
        WHEN jsonb_typeof(normalized.target -> 'notificationRoutes') = 'array'
          THEN normalized.target -> 'notificationRoutes'
        ELSE jsonb_build_array(
          jsonb_build_object(
            'conversationJid',
            normalized.target #>> '{executionContext,conversationJid}',
            'threadId',
            COALESCE(normalized.target #> '{executionContext,threadId}', 'null'::jsonb),
            'label',
            'Primary'
          )
        )
      END AS notification_routes_json
    FROM normalized
  )
  SELECT (
    (derived.target - 'linkedSessions' - 'sessionId' - 'threadId' - 'groupScope')
    || jsonb_build_object(
      'executionContext',
      jsonb_build_object(
        'conversationJid',
        derived.conversation_jid,
        'threadId',
        derived.thread_id_json,
        'groupScope',
        derived.group_scope
      ) || CASE
        WHEN derived.session_id_json = 'null'::jsonb THEN '{}'::jsonb
        ELSE jsonb_build_object('sessionId', derived.session_id_json)
      END,
      'notificationRoutes',
      derived.notification_routes_json
    )
  )::text
  FROM derived
)
WHERE (
  COALESCE(NULLIF(target_json, '')::jsonb ? 'linkedSessions', false)
  OR COALESCE(NULLIF(target_json, '')::jsonb ? 'sessionId', false)
  OR COALESCE(NULLIF(target_json, '')::jsonb ? 'threadId', false)
  OR COALESCE(NULLIF(target_json, '')::jsonb ? 'groupScope', false)
  OR NULLIF(target_json, '')::jsonb #> '{executionContext}' IS NULL
  OR NULLIF(target_json, '')::jsonb #>> '{executionContext,conversationJid}' IS NULL
  OR NULLIF(target_json, '')::jsonb #>> '{executionContext,groupScope}' IS NULL
  OR COALESCE(
    jsonb_typeof(NULLIF(target_json, '')::jsonb -> 'notificationRoutes'),
    ''
  ) <> 'array'
);
--> statement-breakpoint

DROP INDEX IF EXISTS idx_jobs_target_session_updated;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_jobs_target_session_updated
  ON jobs ((target_json::jsonb #>> '{executionContext,sessionId}'), updated_at DESC, created_at DESC);
