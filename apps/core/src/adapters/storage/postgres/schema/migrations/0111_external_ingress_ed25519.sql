-- Drop legacy symmetric secrets and add Ed25519 asymmetric key signing support to external ingresses
ALTER TABLE external_ingresses
  DROP COLUMN IF EXISTS secret,
  ADD COLUMN IF NOT EXISTS signature_algorithm text NOT NULL DEFAULT 'ed25519',
  ADD COLUMN IF NOT EXISTS public_key text;
