CREATE TABLE IF NOT EXISTS "brain_dream_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"run_id" text,
	"decision_id" text NOT NULL,
	"action" text NOT NULL,
	"canonical_op_json" jsonb NOT NULL,
	"review_snapshot_json" jsonb NOT NULL,
	"state" text DEFAULT 'pending_review' NOT NULL,
	"reviewer_user_id" text,
	"reviewer_conversation_jid" text,
	"reviewer_provider_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"outcome" text,
	"error" text,
	CONSTRAINT "brain_dream_reviews_decision_id_unique" UNIQUE("decision_id"),
	CONSTRAINT "brain_dream_reviews_state_check" CHECK ("brain_dream_reviews"."state" IN ('pending_review', 'applying', 'applied', 'rejected', 'stale', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_dream_review_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"review_id" text NOT NULL,
	"app_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"expected_version" text,
	"open" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_dream_review_targets_kind_check" CHECK ("brain_dream_review_targets"."target_kind" IN ('page', 'entity', 'edge'))
);
--> statement-breakpoint
ALTER TABLE "brain_dream_reviews" ADD CONSTRAINT "brain_dream_reviews_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_dream_reviews" ADD CONSTRAINT "brain_dream_reviews_decision_id_brain_dream_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "brain_dream_decisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_dream_review_targets" ADD CONSTRAINT "brain_dream_review_targets_review_id_brain_dream_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "brain_dream_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_brain_dream_reviews_pending" ON "brain_dream_reviews" USING btree ("app_id","state","created_at");--> statement-breakpoint
CREATE INDEX "idx_brain_dream_review_targets_review" ON "brain_dream_review_targets" USING btree ("review_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_brain_dream_review_targets_open_unique" ON "brain_dream_review_targets" USING btree ("app_id","target_kind","target_id") WHERE "open";
