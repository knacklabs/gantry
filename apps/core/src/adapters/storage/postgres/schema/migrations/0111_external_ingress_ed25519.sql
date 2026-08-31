-- Add Ed25519 asymmetric key signing support to external ingresses
ALTER TABLE external_ingresses
  ADD COLUMN IF NOT EXISTS signature_algorithm text NOT NULL DEFAULT 'hmac-sha256',
  ADD COLUMN IF NOT EXISTS public_key text;
