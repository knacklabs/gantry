ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_execution_mode_domain;
ALTER TABLE jobs DROP COLUMN IF EXISTS execution_mode;
