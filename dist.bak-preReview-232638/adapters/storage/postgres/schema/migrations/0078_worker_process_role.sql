-- Deployment process role for a worker instance: all | control | live-worker |
-- job-worker. Application-constrained (no DB CHECK to keep role evolution cheap).
-- Default 'all' keeps the workstation single-process registration unchanged.
ALTER TABLE worker_instances
  ADD COLUMN IF NOT EXISTS process_role text NOT NULL DEFAULT 'all';
