-- agent_runs already receive the canonical default and safe-id constraint in
-- 0057. This migration cuts over existing provider session metadata only.
DO $$
DECLARE
  rows_updated integer;
BEGIN
	LOOP
	  WITH batch AS (
	    SELECT id, external_session_id
	    FROM provider_sessions
	    WHERE
	        provider IN ('anthropic', 'anthropic-claude-agent-sdk')
	        OR external_session_id ~ '^anthropic-claude-agent-sdk:'
	        OR (
	          external_session_id ~ '^anthropic:'
	          AND external_session_id !~ '^anthropic:claude-agent-sdk:'
	        )
	        OR provider_ref_json->>'provider' IN ('anthropic', 'anthropic-claude-agent-sdk')
	      LIMIT 10000
	      FOR UPDATE SKIP LOCKED
	    )
	    UPDATE provider_sessions AS ps
	    SET
	      provider = 'anthropic:claude-agent-sdk',
	      external_session_id =
	        CASE
	          WHEN batch.external_session_id ~ '^anthropic-claude-agent-sdk:'
	            THEN regexp_replace(batch.external_session_id, '^anthropic-claude-agent-sdk:', '')
	          WHEN batch.external_session_id ~ '^anthropic:'
	            AND batch.external_session_id !~ '^anthropic:claude-agent-sdk:'
	            THEN regexp_replace(batch.external_session_id, '^anthropic:', '')
	          ELSE batch.external_session_id
	        END,
	      provider_ref_json = jsonb_build_object(
	        'kind', 'provider_session',
	        'value',
	          'anthropic:claude-agent-sdk:' ||
	          CASE
	            WHEN batch.external_session_id ~ '^anthropic-claude-agent-sdk:'
	              THEN regexp_replace(batch.external_session_id, '^anthropic-claude-agent-sdk:', '')
	            WHEN batch.external_session_id ~ '^anthropic:'
	              AND batch.external_session_id !~ '^anthropic:claude-agent-sdk:'
	              THEN regexp_replace(batch.external_session_id, '^anthropic:', '')
	            ELSE batch.external_session_id
	          END,
	        'provider', 'anthropic:claude-agent-sdk',
	        'externalSessionId',
	          CASE
	            WHEN batch.external_session_id ~ '^anthropic-claude-agent-sdk:'
	              THEN regexp_replace(batch.external_session_id, '^anthropic-claude-agent-sdk:', '')
	            WHEN batch.external_session_id ~ '^anthropic:'
	              AND batch.external_session_id !~ '^anthropic:claude-agent-sdk:'
	              THEN regexp_replace(batch.external_session_id, '^anthropic:', '')
	            ELSE batch.external_session_id
	          END
	      )
	    FROM batch
	    WHERE ps.id = batch.id;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;
