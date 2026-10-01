-- Settle ambiguous deliveries a newer revision already superseded, then keep
-- only the latest revision, the one on screen, the one that opened the current
-- message, and revisions whose delivery is still pending or ambiguous. Drop
-- run wait budgets that never waited, keeping waiting runs and the newest 20
-- resumed runs. Drop rerun barriers already enqueued, keeping the newest 20.
-- Each card is read into variables once so a 10k-entry payload is parsed once.
DO $$
DECLARE
  card record;
  latest int;
  deliveries jsonb;
  openers int[];
  kept int[];
BEGIN
  FOR card IN
    SELECT id, payload_json AS payload
    FROM pending_interactions
    WHERE kind = 'job_permission_card'
  LOOP
    latest := (card.payload ->> 'revision')::int;
    SELECT COALESCE(jsonb_agg(
      CASE
        WHEN delivery ->> 'status' = 'ambiguous'
          AND (delivery ->> 'revision')::int < latest
        THEN delivery || '{"status": "cancelled"}'::jsonb
        ELSE delivery
      END ORDER BY ord
    ), '[]'::jsonb)
    INTO deliveries
    FROM jsonb_array_elements(card.payload -> 'revisionDeliveries')
      WITH ORDINALITY AS d(delivery, ord);
    openers := ARRAY(
      SELECT (revision ->> 'revision')::int
      FROM jsonb_array_elements(card.payload -> 'revisions') AS r(revision)
      WHERE revision ->> 'operation' IN ('send', 'replace')
    );
    kept := ARRAY(
      SELECT (delivery ->> 'revision')::int
      FROM jsonb_array_elements(deliveries) AS d(delivery)
      WHERE delivery ->> 'status' IN ('pending', 'ambiguous')
    ) || ARRAY[
      latest,
      (card.payload ->> 'currentProviderRevision')::int,
      (
        SELECT (delivery ->> 'revision')::int
        FROM jsonb_array_elements(deliveries)
          WITH ORDINALITY AS d(delivery, ord)
        WHERE (delivery ->> 'revision')::int = ANY (openers)
          AND delivery ->> 'providerMessageId'
            = card.payload ->> 'currentProviderMessageId'
        ORDER BY ord
        LIMIT 1
      )
    ];
    UPDATE pending_interactions
    SET payload_json = card.payload || jsonb_build_object(
      'revisions', COALESCE((
        SELECT jsonb_agg(revision ORDER BY ord)
        FROM jsonb_array_elements(card.payload -> 'revisions')
          WITH ORDINALITY AS r(revision, ord)
        WHERE (revision ->> 'revision')::int = ANY (kept)
      ), '[]'::jsonb),
      'revisionDeliveries', COALESCE((
        SELECT jsonb_agg(delivery ORDER BY ord)
        FROM jsonb_array_elements(deliveries)
          WITH ORDINALITY AS d(delivery, ord)
        WHERE (delivery ->> 'revision')::int = ANY (kept)
      ), '[]'::jsonb),
      'pendingBudgets', COALESCE((
        SELECT jsonb_agg(budget ORDER BY ord)
        FROM (
          SELECT budget, ord, row_number() OVER (
            PARTITION BY (budget ->> 'openCount')::int > 0,
              (budget ->> 'accumulatedMs')::numeric > 0
            ORDER BY ord DESC
          ) AS newest
          FROM jsonb_array_elements(card.payload -> 'pendingBudgets')
            WITH ORDINALITY AS b(budget, ord)
        ) budgets
        WHERE (budget ->> 'openCount')::int > 0
          OR ((budget ->> 'accumulatedMs')::numeric > 0 AND newest <= 20)
      ), '[]'::jsonb),
      'rerunBarriers', COALESCE((
        SELECT jsonb_agg(barrier ORDER BY ord)
        FROM (
          SELECT barrier, ord, row_number() OVER (
            PARTITION BY barrier ->> 'enqueuedAt' IS NULL
            ORDER BY ord DESC
          ) AS newest
          FROM jsonb_array_elements(card.payload -> 'rerunBarriers')
            WITH ORDINALITY AS rb(barrier, ord)
        ) barriers
        WHERE barrier ->> 'enqueuedAt' IS NULL OR newest <= 20
      ), '[]'::jsonb)
    )
    WHERE id = card.id;
  END LOOP;
END $$;
--> statement-breakpoint
-- A once-need that was applied, withdrawn (cancelled without expiring) or
-- expired before the job's three newest expiries is settled unless a rerun
-- not yet enqueued still requires it; settled needs leave every per-job load.
WITH expired AS (
  SELECT id, row_number() OVER (
    PARTITION BY app_id, payload_json ->> 'jobId'
    ORDER BY payload_json ->> 'expiredAt' DESC,
      payload_json ->> 'createdAt' DESC,
      id DESC
  ) AS newest
  FROM pending_interactions
  WHERE kind = 'job_permission_need'
    AND status = 'pending'
    AND payload_json ->> 'state' = 'cancelled'
    AND payload_json ->> 'expiredAt' IS NOT NULL
)
UPDATE pending_interactions AS need
SET status = 'resolved', resolved_at = COALESCE(need.resolved_at, now())
WHERE need.kind = 'job_permission_need'
  AND need.status = 'pending'
  AND need.payload_json ->> 'grant' = 'once'
  AND (
    need.payload_json ->> 'state' = 'applied'
    OR (
      need.payload_json ->> 'state' = 'cancelled'
      AND need.payload_json ->> 'expiredAt' IS NULL
    )
    OR need.id IN (SELECT id FROM expired WHERE newest > 3)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pending_interactions AS card,
      jsonb_array_elements(card.payload_json -> 'rerunBarriers') AS b(barrier),
      jsonb_array_elements(b.barrier -> 'requiredNeeds') AS r(required)
    WHERE card.kind = 'job_permission_card'
      AND card.app_id = need.app_id
      AND card.payload_json ->> 'jobId' = need.payload_json ->> 'jobId'
      AND b.barrier ->> 'enqueuedAt' IS NULL
      AND r.required ->> 'needId' = need.id
  );
--> statement-breakpoint
-- Keep the newest five request snapshots on each need.
UPDATE pending_interactions
SET payload_json = jsonb_set(
  payload_json,
  '{requestSnapshots}',
  (
    SELECT jsonb_agg(snapshot ORDER BY ord)
    FROM jsonb_array_elements(payload_json -> 'requestSnapshots')
      WITH ORDINALITY AS s(snapshot, ord)
    WHERE ord > jsonb_array_length(payload_json -> 'requestSnapshots') - 5
  )
)
WHERE kind = 'job_permission_need'
  AND jsonb_array_length(payload_json -> 'requestSnapshots') > 5;
