-- The previous migration's dedupe kept the NEWEST row per (agent, tool,
-- config version) tuple, which on live installs was usually the permission
-- writer's digest-id row (`agent-tool-binding:permission:<hash>`), not the
-- canonical importer row (`agent-tool-binding:<agentId>:<toolId>`). The
-- startup desired-state sync then inserts the canonical id and hits the
-- NULLS NOT DISTINCT unique tuple, crashlooping the runtime. Normalize:
-- drop digest rows whose canonical id already exists, rename the rest.
DELETE FROM "agent_tool_bindings" d
USING "agent_tool_bindings" c
WHERE d.id LIKE 'agent-tool-binding:permission:%'
  AND c.id = 'agent-tool-binding:' || d.agent_id || ':' || d.tool_id
    || CASE WHEN d.person_id IS NOT NULL THEN ':' || d.person_id ELSE '' END;--> statement-breakpoint
UPDATE "agent_tool_bindings"
SET id = 'agent-tool-binding:' || agent_id || ':' || tool_id
    || CASE WHEN person_id IS NOT NULL THEN ':' || person_id ELSE '' END
WHERE id LIKE 'agent-tool-binding:permission:%';
