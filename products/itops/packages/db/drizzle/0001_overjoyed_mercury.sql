CREATE TABLE "slack_source_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) DEFAULT 'slack' NOT NULL,
	"workspace_id" varchar(100) NOT NULL,
	"channel_id" varchar(100) NOT NULL,
	"message_ts" varchar(100) NOT NULL,
	"thread_ts" varchar(100),
	"sender_external_user_id" varchar(150),
	"raw_text" text NOT NULL,
	"detected_type" varchar(100) NOT NULL,
	"processed_status" varchar(80) DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_message_id" uuid NOT NULL,
	"employee_id" uuid,
	"google_workspace_access_request_id" uuid,
	"name" varchar(255),
	"personal_email" varchar(255),
	"contact_no" varchar(50),
	"doj" date,
	"employment_type" varchar(50),
	"designation" varchar(180),
	"laptop" varchar(120),
	"relocation" varchar(120),
	"requested_slack_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(80) DEFAULT 'received' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "designation_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(180) NOT NULL,
	"employment_type" varchar(50) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "onboarding_intakes" ADD CONSTRAINT "onboarding_intakes_source_message_id_slack_source_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."slack_source_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_intakes" ADD CONSTRAINT "onboarding_intakes_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_intakes" ADD CONSTRAINT "onboarding_intakes_google_workspace_access_request_id_access_requests_id_fk" FOREIGN KEY ("google_workspace_access_request_id") REFERENCES "public"."access_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_source_messages_provider_workspace_channel_message_unique" ON "slack_source_messages" USING btree ("provider","workspace_id","channel_id","message_ts");--> statement-breakpoint
CREATE INDEX "onboarding_intakes_source_message_id_idx" ON "onboarding_intakes" USING btree ("source_message_id");--> statement-breakpoint
CREATE INDEX "onboarding_intakes_employee_id_idx" ON "onboarding_intakes" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "onboarding_intakes_google_workspace_access_request_id_idx" ON "onboarding_intakes" USING btree ("google_workspace_access_request_id");--> statement-breakpoint
CREATE INDEX "onboarding_intakes_status_idx" ON "onboarding_intakes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "onboarding_intakes_personal_email_idx" ON "onboarding_intakes" USING btree ("personal_email");--> statement-breakpoint
CREATE UNIQUE INDEX "designation_catalog_employment_type_name_unique" ON "designation_catalog" USING btree ("employment_type","name");