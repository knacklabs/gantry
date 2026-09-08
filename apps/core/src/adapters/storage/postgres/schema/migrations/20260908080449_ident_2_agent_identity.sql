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
ALTER TABLE "identity_offboarding_audit" ADD CONSTRAINT "identity_offboarding_audit_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identity_offboarding_audit_app_idempotency" ON "identity_offboarding_audit" USING btree ("app_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_app_user_fk" FOREIGN KEY ("app_id","person_id") REFERENCES "users"("app_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_alias_fk" FOREIGN KEY ("alias_id") REFERENCES "user_aliases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_service_agent" ON "users" USING btree ("agent_id") WHERE "users"."agent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_service_agent_kind_check"
  CHECK (("agent_id" IS NULL AND "kind" <> 'service') OR ("agent_id" IS NOT NULL AND "kind" = 'service'));--> statement-breakpoint
ALTER TABLE "conversation_approvers" ADD CONSTRAINT "conversation_approvers_person_required"
  CHECK ("external_user_id" = '' OR "person_id" IS NOT NULL);
