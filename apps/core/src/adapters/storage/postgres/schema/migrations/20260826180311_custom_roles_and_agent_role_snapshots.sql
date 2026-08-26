CREATE TABLE "custom_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"source_role_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_roles_app_id_name_unique" UNIQUE("app_id","name")
);
--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "role_display_name" text;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "role_prompt" text;--> statement-breakpoint
ALTER TABLE "agent_config_versions" ADD COLUMN "source_role_id" text;--> statement-breakpoint
ALTER TABLE "custom_roles" ADD CONSTRAINT "custom_roles_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;