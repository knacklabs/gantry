CREATE INDEX idx_jobs_status_lease_expires ON jobs(status, lease_expires_at);
