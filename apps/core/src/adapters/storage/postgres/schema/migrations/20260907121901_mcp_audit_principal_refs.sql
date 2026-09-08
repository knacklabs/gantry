-- Custom SQL migration file, put your code below! --
-- Preserve `actor_id` while canonicalizing historical literal sources.
-- This table has no authority-bearing actor rows that can be safely inferred
-- as a Person without an alias lookup, so unknown history stays system-owned.
UPDATE mcp_server_audit_events
SET actor_id = json_build_object('kind', 'system', 'source', actor_id)::text
WHERE actor_id IS NOT NULL
  AND actor_id !~ E'^\\s*\\{\\s*"kind"\\s*:';
