DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM user_aliases
    WHERE retired_at IS NULL
      AND (
        provider = 'email'
        OR evidence_json->>'evidenceType' = 'email'
      )
      AND btrim(external_user_id) = ''
  ) THEN
    RAISE EXCEPTION
      'Cannot normalize contact aliases: an active email alias is empty';
  END IF;

  IF EXISTS (
    WITH normalized_phones AS (
      SELECT
        btrim(external_user_id) AS original_external_user_id,
        CASE
        WHEN btrim(external_user_id) LIKE '00%'
          THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
        WHEN btrim(external_user_id) LIKE '+%'
          THEN '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
        ELSE NULL
      END AS normalized_external_user_id
      FROM user_aliases
      WHERE retired_at IS NULL
        AND (
          provider = 'phone'
          OR evidence_json->>'evidenceType' = 'phone'
        )
    )
    SELECT 1
    FROM normalized_phones
    WHERE original_external_user_id !~ '^(\+|00)[0-9[:space:]().-]+$'
       OR normalized_external_user_id IS NULL
       OR normalized_external_user_id !~ '^\+[1-9][0-9]{1,14}$'
  ) THEN
    RAISE EXCEPTION
      'Cannot normalize contact aliases: an active phone alias is not valid E.164 input';
  END IF;

  IF EXISTS (
    WITH normalized_aliases AS (
      SELECT
        app_id,
        provider,
        COALESCE(provider_account_id, '') AS provider_account_id,
        CASE
          WHEN provider = 'email' OR evidence_json->>'evidenceType' = 'email'
            THEN lower(btrim(external_user_id))
          WHEN provider = 'phone' OR evidence_json->>'evidenceType' = 'phone'
            THEN CASE
              WHEN btrim(external_user_id) LIKE '00%'
                THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
              ELSE '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
            END
          ELSE external_user_id
        END AS external_user_id
      FROM user_aliases
      WHERE retired_at IS NULL
    )
    SELECT 1
    FROM normalized_aliases
    GROUP BY app_id, provider, provider_account_id, external_user_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot normalize contact aliases: normalized values collide under the active alias unique index';
  END IF;
END $$;

UPDATE user_aliases
SET
  external_user_id = CASE
    WHEN provider = 'email' OR evidence_json->>'evidenceType' = 'email'
      THEN lower(btrim(external_user_id))
    WHEN provider = 'phone' OR evidence_json->>'evidenceType' = 'phone'
      THEN CASE
        WHEN btrim(external_user_id) LIKE '00%'
          THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
        ELSE '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
      END
    ELSE external_user_id
  END,
  updated_at = now()
WHERE (provider IN ('email', 'phone')
   OR evidence_json->>'evidenceType' IN ('email', 'phone'))
  AND retired_at IS NULL;

-- Retired tombstones must match normalized lookups (they gate alias re-binding),
-- so normalize them too — but only where the stored value normalizes cleanly.
-- Values that do not normalize to a valid form are left byte-for-byte untouched:
-- they can never match a valid normalized request, so they bypass nothing.
UPDATE user_aliases
SET
  external_user_id = CASE
    WHEN provider = 'email' OR evidence_json->>'evidenceType' = 'email'
      THEN lower(btrim(external_user_id))
    ELSE CASE
      WHEN btrim(external_user_id) LIKE '00%'
        THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
      ELSE '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
    END
  END,
  updated_at = now()
WHERE (provider IN ('email', 'phone')
   OR evidence_json->>'evidenceType' IN ('email', 'phone'))
  AND retired_at IS NOT NULL
  AND CASE
    WHEN provider = 'email' OR evidence_json->>'evidenceType' = 'email'
      THEN lower(btrim(external_user_id)) IS DISTINCT FROM external_user_id
    ELSE btrim(external_user_id) ~ '^(\+|00)'
      AND (CASE
        WHEN btrim(external_user_id) LIKE '00%'
          THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
        ELSE '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
      END) ~ '^\+[1-9][0-9]{1,14}$'
      AND (CASE
        WHEN btrim(external_user_id) LIKE '00%'
          THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
        ELSE '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
      END) IS DISTINCT FROM external_user_id
  END;
