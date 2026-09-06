ALTER TABLE "external_ingresses" ADD COLUMN "signature_algorithm" text DEFAULT 'ed25519' NOT NULL;
ALTER TABLE "external_ingresses" ADD COLUMN "public_key" text DEFAULT '' NOT NULL;
ALTER TABLE "external_ingresses" DROP COLUMN "secret";
