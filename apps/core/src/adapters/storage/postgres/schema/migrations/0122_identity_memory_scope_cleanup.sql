-- Group/channel rows may carry the historical user_id column even though
-- their canonical subject is the conversation. Clear that denormalization
-- before the app-scoped person FK is used for personal memory rows.
UPDATE memory_items
SET user_id = NULL
WHERE subject_type <> 'user'
  AND user_id IS NOT NULL;
