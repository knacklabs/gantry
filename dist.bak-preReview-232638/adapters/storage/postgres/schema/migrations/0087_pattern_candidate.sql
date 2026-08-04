CREATE TABLE "pattern_candidates" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL,
  "agent_id" text NOT NULL,
  "folder" text NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "signature" text NOT NULL,
  "outcome_label" text NOT NULL,
  "short_ask" text NOT NULL,
  "occurrences" integer NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "last_detected_at" timestamp with time zone NOT NULL,
  "candidate_status" text DEFAULT 'detected' NOT NULL,
  "proposal_status" text,
  "snoozed_until" timestamp with time zone,
  "evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

ALTER TABLE "pattern_candidates"
  ADD CONSTRAINT "pattern_candidates_app_id_apps_id_fk"
  FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade;

CREATE UNIQUE INDEX "pattern_candidates_signature_unique"
  ON "pattern_candidates" (
    "app_id",
    "agent_id",
    "subject_type",
    "subject_id",
    "signature"
  );

CREATE INDEX "idx_pattern_candidates_eligible"
  ON "pattern_candidates" (
    "app_id",
    "agent_id",
    "subject_type",
    "subject_id",
    "candidate_status"
  );
