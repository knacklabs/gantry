ALTER TABLE permission_promotion_counters
  ADD COLUMN IF NOT EXISTS last_offered_at timestamptz;
