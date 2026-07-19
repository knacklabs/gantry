-- Active-development cutover: pending permission prompts are intentionally not
-- backfilled. They are short-lived, so a live machine naturally re-creates them.
DELETE FROM "pending_interactions" WHERE "kind" = 'permission';
--> statement-breakpoint
CREATE TABLE "permission_prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"source_agent_folder" text NOT NULL,
	"interaction_id" text NOT NULL,
	"match_kind" text NOT NULL,
	"member_count" integer NOT NULL,
	"rendered_decision_options_json" jsonb NOT NULL,
	"rendered_request_json" jsonb NOT NULL,
	"target_jid" text,
	"approval_context_jid" text,
	"thread_id" text,
	"decision_policy" text,
	"full_view_json" jsonb,
	"external_prompt_provider" text,
	"external_prompt_conversation_id" text,
	"external_prompt_message_id" text,
	"external_prompt_thread_id" text,
	"provider_aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"claim_id" text,
	"claim_mode" text,
	"claim_approver_ref" text,
	"claimed_at" timestamp with time zone,
	"settlement_state" text DEFAULT 'open' NOT NULL,
	"settled_at" timestamp with time zone,
	"canonical_batch_id" text,
	"parent_envelope_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD COLUMN "envelope_id" text;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD COLUMN "member_index" integer;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD COLUMN "source_agent_folder" text;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD COLUMN "request_id" text;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD COLUMN "run_lease_token" text;--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD COLUMN "run_lease_fencing_version" integer;--> statement-breakpoint
UPDATE "pending_interactions"
SET
	"source_agent_folder" = COALESCE(
		"payload_json" ->> 'sourceAgentFolder',
		"payload_json" #>> '{request,sourceAgentFolder}'
	),
	"request_id" = "payload_json" ->> 'requestId',
	"run_lease_token" = CASE
		WHEN jsonb_typeof("payload_json" -> 'runLeaseToken') = 'string'
			THEN "payload_json" ->> 'runLeaseToken'
		ELSE NULL
	END,
	"run_lease_fencing_version" = CASE
		WHEN jsonb_typeof("payload_json" -> 'runLeaseFencingVersion') = 'number'
			AND ("payload_json" ->> 'runLeaseFencingVersion') ~ '^[1-9][0-9]*$'
			AND ("payload_json" ->> 'runLeaseFencingVersion')::numeric <= 2147483647
			THEN ("payload_json" ->> 'runLeaseFencingVersion')::integer
		ELSE NULL
	END
WHERE "kind" = 'question';
--> statement-breakpoint
ALTER TABLE "permission_prompts" ADD CONSTRAINT "permission_prompts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_prompts" ADD CONSTRAINT "permission_prompts_parent_envelope_id_permission_prompts_id_fk" FOREIGN KEY ("parent_envelope_id") REFERENCES "permission_prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_scope" ON "permission_prompts" USING btree ("app_id","source_agent_folder","interaction_id","settlement_state");--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_message" ON "permission_prompts" USING btree ("app_id","external_prompt_provider","external_prompt_conversation_id","external_prompt_message_id","external_prompt_thread_id");--> statement-breakpoint
CREATE INDEX "idx_permission_prompts_parent" ON "permission_prompts" USING btree ("parent_envelope_id");--> statement-breakpoint
ALTER TABLE "pending_interactions" ADD CONSTRAINT "pending_interactions_envelope_id_permission_prompts_id_fk" FOREIGN KEY ("envelope_id") REFERENCES "permission_prompts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_request_lookup" ON "pending_interactions" USING btree ("app_id","kind","source_agent_folder","request_id","status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_interactions_envelope_member" ON "pending_interactions" USING btree ("envelope_id","member_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pending_interactions_envelope_request" ON "pending_interactions" USING btree ("envelope_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_pending_interactions_envelope_status" ON "pending_interactions" USING btree ("envelope_id","status","expires_at");
