CREATE TABLE "observer_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"recipient" text NOT NULL,
	"local_day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observer_insight_cursors" (
	"app_id" text NOT NULL,
	"subject" text NOT NULL,
	"cursor_updated_at" timestamp with time zone,
	"cursor_page_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observer_insight_cursors_pk" PRIMARY KEY("app_id","subject"),
	CONSTRAINT "observer_insight_cursors_complete_cursor_check" CHECK (("observer_insight_cursors"."cursor_updated_at" IS NULL) = ("observer_insight_cursors"."cursor_page_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "proactive_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"subject" text NOT NULL,
	"insight_type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"batch_snapshot_at" timestamp with time zone NOT NULL,
	"evidence_version" integer NOT NULL,
	"canonical_signature" text NOT NULL,
	"signature_embedding_ref" text,
	"confidence" double precision NOT NULL,
	"priority_score" double precision NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"cooldown_until" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"surfaced_at" timestamp with time zone,
	"recipient" text NOT NULL,
	"delivery_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proactive_insights_insight_type_check" CHECK ("proactive_insights"."insight_type" IN ('commitment', 'contradiction', 'open_question', 'stale_fact', 'decision_without_owner', 'duplicated_work', 'repetition')),
	CONSTRAINT "proactive_insights_state_check" CHECK ("proactive_insights"."state" IN ('pending', 'claimed', 'sent', 'cooldown', 'resolved', 'dropped')),
	CONSTRAINT "proactive_insights_evidence_version_check" CHECK ("proactive_insights"."evidence_version" > 0),
	CONSTRAINT "proactive_insights_confidence_check" CHECK ("proactive_insights"."confidence" >= 0 AND "proactive_insights"."confidence" <= 1)
);
--> statement-breakpoint
ALTER TABLE "observer_deliveries" ADD CONSTRAINT "observer_deliveries_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observer_insight_cursors" ADD CONSTRAINT "observer_insight_cursors_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_insights" ADD CONSTRAINT "proactive_insights_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_insights" ADD CONSTRAINT "proactive_insights_delivery_id_observer_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "observer_deliveries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "observer_deliveries_app_recipient_day_unique" ON "observer_deliveries" USING btree ("app_id","recipient","local_day");--> statement-breakpoint
CREATE INDEX "idx_proactive_insights_queue" ON "proactive_insights" USING btree ("app_id","subject","state","priority_score" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_proactive_insights_app_signature" ON "proactive_insights" USING btree ("app_id","canonical_signature") WHERE "state" IN ('pending', 'claimed', 'sent', 'cooldown');
