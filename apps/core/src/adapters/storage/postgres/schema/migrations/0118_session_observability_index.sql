CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation_created
  ON agent_runs (app_id, conversation_id, created_at DESC, id DESC);--> statement-breakpoint
-- Backfill the read key BEFORE the session feed starts filtering on it.
--
-- The feed switches from session_id to the canonical conversation_id. Events
-- written earlier carry the session id and a NULL conversation id, so without
-- this they silently vanish from every existing session's history (444 such
-- rows on the reference deployment at review time). Every one of them resolves
-- through agent_sessions, which runtime_events.session_id already references by
-- foreign key, so the mapping is guaranteed present.
--
-- Idempotent: only NULL conversation ids are touched, so a re-run is a no-op.
UPDATE runtime_events AS event
SET conversation_id = session.conversation_id
FROM agent_sessions AS session
WHERE session.id = event.session_id
  AND event.session_id IS NOT NULL
  AND event.conversation_id IS NULL
  AND session.conversation_id IS NOT NULL;
