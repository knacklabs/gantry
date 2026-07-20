CREATE UNIQUE INDEX IF NOT EXISTS users_app_id_id_key
  ON users (app_id, id);

ALTER TABLE conversation_participants
  DROP CONSTRAINT IF EXISTS conversation_participants_user_id_users_id_fk;

ALTER TABLE conversation_participants
  ADD CONSTRAINT conversation_participants_app_user_fk
  FOREIGN KEY (app_id, user_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;

ALTER TABLE memory_items
  DROP CONSTRAINT IF EXISTS memory_items_user_id_users_id_fk;

-- Group/channel rows may carry the historical user_id column even though
-- their canonical subject is the conversation. The app-scoped person FK is
-- only meaningful for personal rows; clear that legacy denormalization before
-- adding the constraint so existing installations can migrate safely.
UPDATE memory_items
SET user_id = NULL
WHERE subject_type <> 'user'
  AND user_id IS NOT NULL;

ALTER TABLE memory_items
  ADD CONSTRAINT memory_items_app_user_fk
  FOREIGN KEY (app_id, user_id)
  REFERENCES users (app_id, id)
  ON DELETE CASCADE;

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
