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
      WHERE provider IN ('anthropic', 'anthropic-claude-agent-sdk')
      LIMIT 10000
    )
    UPDATE provider_sessions AS ps
    SET
      provider = 'anthropic:claude-agent-sdk',
      external_session_id = regexp_replace(
        batch.external_session_id,
        '^(anthropic(-claude-agent-sdk)?:)+',
        ''
      ),
      provider_ref_json = jsonb_build_object(
        'kind', 'provider_session',
        'value',
          'anthropic:claude-agent-sdk:' || regexp_replace(
            batch.external_session_id,
            '^(anthropic(-claude-agent-sdk)?:)+',
            ''
          ),
        'provider', 'anthropic:claude-agent-sdk',
        'externalSessionId',
          regexp_replace(
            batch.external_session_id,
            '^(anthropic(-claude-agent-sdk)?:)+',
            ''
          )
      ),
      updated_at = now()
    FROM batch
    WHERE ps.id = batch.id;

    GET DIAGNOSTICS rows_updated = ROW_COUNT;
    EXIT WHEN rows_updated = 0;
  END LOOP;
END $$;
