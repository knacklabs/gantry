ALTER TABLE "users" ADD COLUMN "agent_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_service_agent" ON "users" USING btree ("agent_id") WHERE "users"."agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_service_agent_kind_check"
  CHECK (("agent_id" IS NULL AND "kind" <> 'service') OR ("agent_id" IS NOT NULL AND "kind" = 'service'));--> statement-breakpoint
INSERT INTO "users" (
  "id", "app_id", "agent_id", "kind", "display_name", "status", "created_at", "updated_at"
)
SELECT
  'person:' || substring(
    encode(
      public.digest(
        convert_to("app_id", 'UTF8')
        || decode('00', 'hex')
        || convert_to('service', 'UTF8')
        || decode('00', 'hex')
        || convert_to("id", 'UTF8'),
        'sha256'
      ),
      'hex'
    ) from 1 for 32
  ),
  "app_id",
  "id",
  'service',
  "name",
  "status",
  "created_at",
  "updated_at"
FROM "agents"
ON CONFLICT ("agent_id") WHERE "agent_id" IS NOT NULL
DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "status" = EXCLUDED."status",
  "updated_at" = EXCLUDED."updated_at";
