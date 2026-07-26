CREATE TABLE IF NOT EXISTS "observer_insight_feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"recipient" text NOT NULL,
	"insight_id" text NOT NULL,
	"delivery_id" text,
	"actor_user_id" text NOT NULL,
	"insight_type" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observer_insight_feedback_action_check" CHECK ("observer_insight_feedback"."action" IN ('resolve', 'dismiss', 'snooze', 'less_like_this'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "observer_insight_type_suppressions" (
	"app_id" text NOT NULL,
	"recipient" text NOT NULL,
	"insight_type" text NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"suppressed_until" timestamp with time zone,
	"last_feedback_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observer_insight_type_suppressions_pk" PRIMARY KEY("app_id","recipient","insight_type")
);
--> statement-breakpoint
ALTER TABLE "observer_insight_feedback" ADD CONSTRAINT "observer_insight_feedback_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observer_insight_feedback" ADD CONSTRAINT "observer_insight_feedback_insight_id_fk" FOREIGN KEY ("insight_id") REFERENCES "proactive_insights"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observer_insight_feedback" ADD CONSTRAINT "observer_insight_feedback_delivery_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "observer_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observer_insight_type_suppressions" ADD CONSTRAINT "observer_insight_type_suppressions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "observer_insight_feedback_insight_actor_action_unique" ON "observer_insight_feedback" USING btree ("insight_id","actor_user_id","action");
