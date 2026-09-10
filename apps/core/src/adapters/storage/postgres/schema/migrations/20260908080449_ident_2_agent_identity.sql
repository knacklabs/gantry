CREATE TABLE "identity_offboarding_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"person_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"actor" text NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD COLUMN "alias_id" text;--> statement-breakpoint
UPDATE "conversation_approvers" AS approver
SET "person_id" = participant."user_id"
FROM "conversation_participants" AS participant
JOIN "users" AS person
  ON person."id" = participant."user_id"
  AND person."app_id" = participant."app_id"
  AND person."kind" = 'human'
WHERE approver."app_id" = participant."app_id"
  AND approver."conversation_id" = participant."conversation_id"
  AND approver."external_user_id" = participant."external_user_id"
  AND participant."status" = 'active'
  AND approver."external_user_id" <> '';--> statement-breakpoint
UPDATE "conversation_approvers" AS approver
SET
  "person_id" = alias."user_id",
  "alias_id" = alias."id"
FROM "conversations" AS conversation
  , "provider_accounts" AS account
  , "user_aliases" AS alias
  , "users" AS person
WHERE approver."conversation_id" = conversation."id"
  AND approver."app_id" = conversation."app_id"
  AND account."id" = conversation."provider_account_id"
  AND account."app_id" = conversation."app_id"
  AND alias."app_id" = conversation."app_id"
  AND alias."provider" = account."provider_id"
  AND alias."provider_account_id" = account."id"
  AND alias."external_user_id" = approver."external_user_id"
  AND alias."retired_at" IS NULL
  AND person."id" = alias."user_id"
  AND person."app_id" = alias."app_id"
  AND person."kind" = 'human'
  AND approver."person_id" IS NULL
  AND approver."external_user_id" <> '';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "conversation_approvers"
    WHERE "external_user_id" <> ''
      AND "person_id" IS NULL
  ) THEN
    RAISE EXCEPTION
      'conversation approver identity migration requires every authority-bearing approver to resolve to an active human Person';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "identity_offboarding_audit" ADD CONSTRAINT "identity_offboarding_audit_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identity_offboarding_audit_app_idempotency" ON "identity_offboarding_audit" USING btree ("app_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_app_user_fk" FOREIGN KEY ("app_id","person_id") REFERENCES "users"("app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_alias_fk" FOREIGN KEY ("alias_id") REFERENCES "user_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_service_agent" ON "users" USING btree ("agent_id") WHERE "users"."agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_service_agent_kind_check"
  CHECK (("agent_id" IS NULL AND "kind" <> 'service') OR ("agent_id" IS NOT NULL AND "kind" = 'service'));--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_person_required"
  CHECK ("external_user_id" = '' OR "person_id" IS NOT NULL);
