DROP TABLE IF EXISTS agent_dm_approvers;
--> statement-breakpoint
DROP TABLE IF EXISTS agent_dm_access;
--> statement-breakpoint
ALTER TABLE IF EXISTS agent_conversation_bindings
  DROP COLUMN IF EXISTS is_admin_binding;
--> statement-breakpoint
ALTER TABLE IF EXISTS agent_channel_bindings
  DROP COLUMN IF EXISTS is_admin_binding;
--> statement-breakpoint
ALTER TABLE IF EXISTS registered_groups
  DROP COLUMN IF EXISTS is_main;
