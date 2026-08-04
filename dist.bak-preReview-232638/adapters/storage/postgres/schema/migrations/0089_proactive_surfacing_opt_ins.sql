CREATE TABLE "proactive_surfacing_opt_ins" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "conversation_jid" text,
  "proactive_surfacing_enabled" boolean DEFAULT false NOT NULL,
  "enabled_at" timestamp with time zone,
  "opted_out_at" timestamp with time zone,
  "enabled_by_actor_id" text,
  "opted_out_by_actor_id" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

ALTER TABLE "proactive_surfacing_opt_ins"
  ADD CONSTRAINT "proactive_surfacing_opt_ins_app_id_apps_id_fk"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade;

CREATE UNIQUE INDEX "proactive_surfacing_opt_ins_subject_unique"
  ON "proactive_surfacing_opt_ins" (
    "app_id",
    "agent_id",
    "subject_type",
    "subject_id"
  );
