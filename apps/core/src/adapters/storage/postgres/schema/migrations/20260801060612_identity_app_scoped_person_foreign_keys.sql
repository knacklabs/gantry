CREATE UNIQUE INDEX IF NOT EXISTS users_app_id_id_key
  ON users (app_id, id);

ALTER TABLE conversation_participants
  DROP CONSTRAINT IF EXISTS conversation_participants_user_id_users_id_fk;

-- No-legacy cleanup: participants attributed to a person row that does not
-- exist cannot survive the app-scoped foreign key.
DELETE FROM conversation_participants cp
WHERE cp.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.app_id = cp.app_id AND u.id = cp.user_id
  );

ALTER TABLE conversation_participants
  ADD CONSTRAINT conversation_participants_app_user_fk
  FOREIGN KEY (app_id, user_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;

ALTER TABLE memory_items
  DROP CONSTRAINT IF EXISTS memory_items_user_id_users_id_fk;

-- Group/channel/common rows may carry historical denormalized user_id values
-- that are not personal-memory owners. Clear them before enforcing the
-- app-scoped person foreign key.
UPDATE memory_items
SET user_id = NULL
WHERE subject_type <> 'user'
  AND user_id IS NOT NULL;

-- Personal memory whose owning person row is gone is unattributable; drop it
-- rather than fail the upgrade at the foreign key.
DELETE FROM memory_items mi
WHERE mi.subject_type = 'user'
  AND mi.user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM users u WHERE u.app_id = mi.app_id AND u.id = mi.user_id
  );

ALTER TABLE memory_items
  ADD CONSTRAINT memory_items_app_user_fk
  FOREIGN KEY (app_id, user_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;

-- Audit rows referencing missing people cannot satisfy the new keys.
DELETE FROM person_merge_audit pma
WHERE NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.app_id = pma.app_id AND u.id = pma.source_person_id
  )
  OR NOT EXISTS (
    SELECT 1 FROM users u
    WHERE u.app_id = pma.app_id AND u.id = pma.target_person_id
  );

ALTER TABLE person_merge_audit
  ADD CONSTRAINT person_merge_audit_app_source_person_fk
  FOREIGN KEY (app_id, source_person_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;

ALTER TABLE person_merge_audit
  ADD CONSTRAINT person_merge_audit_app_target_person_fk
  FOREIGN KEY (app_id, target_person_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;
