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
ALTER TABLE "identity_offboarding_audit" ADD CONSTRAINT "identity_offboarding_audit_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_identity_offboarding_audit_app_idempotency" ON "identity_offboarding_audit" USING btree ("app_id","idempotency_key");
