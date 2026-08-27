ALTER TABLE "agent_config_versions" ADD COLUMN "agent_name_snapshot" text;--> statement-breakpoint
UPDATE "agent_config_versions"
SET "agent_name_snapshot" = "agents"."name"
FROM "agents"
WHERE "agent_config_versions"."agent_id" = "agents"."id"
  AND "agent_config_versions"."agent_name_snapshot" IS NULL;
