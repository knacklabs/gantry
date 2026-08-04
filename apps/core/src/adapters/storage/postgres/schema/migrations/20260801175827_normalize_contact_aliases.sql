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

  -- Same-person duplicates that collapse under normalization (Foo@ vs foo@)
  -- are routine data, not an upgrade failure: keep the newest per normalized
  -- key and retire the rest. Only CROSS-person collisions abort below —
  -- those cannot be resolved without guessing which person owns the contact.
  UPDATE user_aliases ua
  SET retired_at = now(), retired_by = 'migration:normalize-contact-aliases',
      verification_status = 'retired', updated_at = now()
  FROM (
    SELECT id, row_number() OVER (
             PARTITION BY app_id, user_id, provider,
                          COALESCE(provider_account_id, ''),
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
                          END
             ORDER BY updated_at DESC, id DESC
           ) AS rn
    FROM user_aliases
    WHERE retired_at IS NULL
      AND (provider IN ('email', 'phone')
        OR evidence_json->>'evidenceType' IN ('email', 'phone'))
  ) dup
  WHERE ua.id = dup.id AND dup.rn > 1;

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
-- so normalize them too — but only where the stored value normalizes cleanly AND
-- the normalized value would not collide with any other person's alias on the
-- same (provider, account) key. Colliding or junk values stay byte-for-byte
-- untouched: an ambiguous tombstone is worse than an unnormalized one, and junk
-- can never match a valid normalized request, so neither bypasses anything.
-- Accepted residual: when EVERY colliding tombstone is a noncanonical spelling
-- of a different person, none is normalized and a new normalized request will
-- not hit any of them — there is no principled way to pick which person's
-- tombstone should gate, so ambiguity resolves to no gate rather than a wrong
-- one.
WITH contact AS (
  SELECT
    id,
    user_id,
    app_id,
    provider,
    COALESCE(provider_account_id, '') AS pa,
    external_user_id,
    CASE
      WHEN provider = 'email' OR evidence_json->>'evidenceType' = 'email'
        THEN lower(btrim(external_user_id))
      WHEN btrim(external_user_id) LIKE '00%'
        AND ('+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g'))
          ~ '^\+[1-9][0-9]{1,14}$'
        THEN '+' || regexp_replace(substr(btrim(external_user_id), 3), '[^0-9]', '', 'g')
      WHEN btrim(external_user_id) LIKE '+%'
        AND ('+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g'))
          ~ '^\+[1-9][0-9]{1,14}$'
        THEN '+' || regexp_replace(substr(btrim(external_user_id), 2), '[^0-9]', '', 'g')
    END AS norm
  FROM user_aliases
  WHERE provider IN ('email', 'phone')
     OR evidence_json->>'evidenceType' IN ('email', 'phone')
)
UPDATE user_aliases ua
SET external_user_id = c.norm, updated_at = now()
FROM contact c
WHERE ua.id = c.id
  AND ua.retired_at IS NOT NULL
  AND c.norm IS NOT NULL
  AND c.norm IS DISTINCT FROM c.external_user_id
  AND NOT EXISTS (
    SELECT 1
    FROM contact other
    WHERE other.app_id = c.app_id
      AND other.provider = c.provider
      AND other.pa = c.pa
      AND other.user_id <> c.user_id
      AND COALESCE(other.norm, other.external_user_id) = c.norm
  );
