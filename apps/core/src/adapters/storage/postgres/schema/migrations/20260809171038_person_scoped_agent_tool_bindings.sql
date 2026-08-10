DROP INDEX "idx_agent_tool_bindings_unique";--> statement-breakpoint
-- Historic installs carry duplicate rows per (agent, tool, config version):
-- the permission writer and the settings importer used different binding ids.
-- Keep the newest row per tuple so the NULLS NOT DISTINCT constraint below
-- can be created; ids converge on the importer format going forward.
DELETE FROM "agent_tool_bindings" a
USING "agent_tool_bindings" b
WHERE a.id <> b.id
  AND a.agent_id = b.agent_id
  AND a.tool_id = b.tool_id
  AND a.config_version_id IS NOT DISTINCT FROM b.config_version_id
  AND (a.updated_at < b.updated_at
    OR (a.updated_at = b.updated_at AND a.id < b.id));--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD COLUMN "person_id" text;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "agent_tool_bindings_app_person_fk" FOREIGN KEY ("app_id","person_id") REFERENCES "users"("app_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_bindings" ADD CONSTRAINT "idx_agent_tool_bindings_unique" UNIQUE NULLS NOT DISTINCT("agent_id","tool_id","config_version_id","person_id");