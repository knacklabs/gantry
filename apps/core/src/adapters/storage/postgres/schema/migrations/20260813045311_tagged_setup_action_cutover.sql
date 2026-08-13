-- Built-in sha256() (PG11+) keeps this runnable by non-superuser roles and
-- under schema-isolated search_paths (no pgcrypto dependency).
--> statement-breakpoint
WITH migrated AS (
  SELECT
    id,
    CASE
      WHEN setup_state ->> 'state' = 'ready' THEN jsonb_build_object(
        'state', 'ready',
        'checked_at', COALESCE(
          setup_state ->> 'checked_at',
          setup_state ->> 'checkedAt',
          updated_at::text
        ),
        'blockers', '[]'::jsonb
      )
      ELSE jsonb_build_object(
        'state', CASE
          WHEN setup_state ->> 'state' IN (
            'missing_capability',
            'broker_unreachable',
            'credential_unknown',
            'browser_login_may_be_required',
            'mcp_missing_credential'
          ) THEN setup_state ->> 'state'
          ELSE 'broker_unreachable'
        END,
        'checked_at', COALESCE(
          setup_state ->> 'checked_at',
          setup_state ->> 'checkedAt',
          updated_at::text
        ),
        'blockers', jsonb_build_array(jsonb_build_object(
          'state', CASE
            WHEN setup_state ->> 'state' IN (
              'missing_capability',
              'broker_unreachable',
              'credential_unknown',
              'browser_login_may_be_required',
              'mcp_missing_credential'
            ) THEN setup_state ->> 'state'
            ELSE 'broker_unreachable'
          END,
          'type', 'tool',
          'id', 'legacy_setup_state',
          'summary', 'This job paused under the old setup format.',
          'action', jsonb_build_object(
            'kind', 'instruction',
            'text', 'This job paused under the old format; resume to re-check.'
          )
        ))
      )
    END AS canonical
  FROM jobs
  WHERE setup_state IS NOT NULL
), fingerprinted AS (
  SELECT
    id,
    canonical,
    encode(
      sha256(
        convert_to(
        CASE
          WHEN canonical ->> 'state' = 'ready'
            THEN '{"blockers":[],"state":"ready"}'
          ELSE concat(
            '{"blockers":[{"action":{"kind":"instruction","text":"This job paused under the old format; resume to re-check."},',
            '"id":"legacy_setup_state","state":',
            to_json(canonical ->> 'state')::text,
            ',"type":"tool"}],"state":',
            to_json(canonical ->> 'state')::text,
            '}'
          )
        END,
        'UTF8'
        )
      ),
      'hex'
    ) AS fingerprint
  FROM migrated
)
UPDATE jobs
SET setup_state = canonical || jsonb_build_object(
  'fingerprint', fingerprint,
  'notified_fingerprint', fingerprint
)
FROM fingerprinted
WHERE jobs.id = fingerprinted.id;
