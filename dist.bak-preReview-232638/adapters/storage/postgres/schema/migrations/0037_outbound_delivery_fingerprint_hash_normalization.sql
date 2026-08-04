CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

UPDATE outbound_deliveries
SET idempotency_fingerprint = CASE
  WHEN idempotency_fingerprint ~ '^sha256:[0-9a-f]{64}$' THEN idempotency_fingerprint
  WHEN idempotency_fingerprint LIKE 'md5:%' THEN 'sha256:' || encode(
    digest(idempotency_fingerprint, 'sha256'),
    'hex'
  )
  WHEN idempotency_fingerprint ~ '^[0-9a-f]{32}$' THEN 'sha256:' || encode(
    digest('md5:' || idempotency_fingerprint, 'sha256'),
    'hex'
  )
  ELSE 'sha256:' || encode(digest(idempotency_fingerprint, 'sha256'), 'hex')
END
WHERE idempotency_fingerprint IS NOT NULL
  AND idempotency_fingerprint !~ '^sha256:[0-9a-f]{64}$';
