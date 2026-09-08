-- Custom SQL migration file, put your code below! --
-- `actor` remains text for column compatibility, but its durable value is now
-- the JSON representation of PrincipalRef. Runtime events historically used
-- system-owned literals (runtime, scheduler, SDK, etc.); preserve each exact
-- literal as the system source instead of guessing a human or service Person.
UPDATE runtime_events
SET actor = json_build_object('kind', 'system', 'source', actor)::text
WHERE actor !~ E'^\\s*\\{\\s*"kind"\\s*:';
