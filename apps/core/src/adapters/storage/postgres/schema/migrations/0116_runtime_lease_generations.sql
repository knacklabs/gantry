CREATE TABLE IF NOT EXISTS "runtime_lease_generations" (
	"lease_key" text PRIMARY KEY NOT NULL,
	"generation" bigint NOT NULL,
	"holder" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "browser_profiles" ADD COLUMN IF NOT EXISTS "snapshot_lease_generation" bigint DEFAULT 0 NOT NULL;
