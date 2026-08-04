-- Replace the legacy per-host browser_profiles registry (id PK, label,
-- storage_state_ref, permission_policy_id) — which was never read or written by
-- any code path — with the durable cross-worker snapshot index keyed on the
-- profile name. The only reference to the old table was a dead
-- provider_sessions.browser_profile_id FK column; drop it first.
ALTER TABLE provider_sessions DROP COLUMN IF EXISTS browser_profile_id;
DROP TABLE IF EXISTS browser_profiles CASCADE;

-- One row per browser profile name. Bytes live in the BrowserProfileArtifactStore
-- (local FS or S3 under browser-profiles/<name>/); this row records the current
-- content hash, storage ref, and the snapshotting worker's lease fence. The
-- upsert applies only when the incoming (snapshot_fencing_version,
-- snapshotted_at) is not older than the stored row (monotonic last-writer-wins),
-- so a recovered-at-higher-fence owner beats a stale writer.
CREATE TABLE browser_profiles (
  profile_name text PRIMARY KEY,
  -- Nullable: snapshot call sites hold the agent folder + profile name, not
  -- always a resolved app_id. The profile name is the durable identity.
  app_id text,
  content_hash text NOT NULL,
  storage_ref text NOT NULL,
  size_bytes bigint NOT NULL DEFAULT 0,
  auth_markers_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  snapshot_worker_instance_id text,
  snapshot_run_id text REFERENCES agent_runs(id) ON DELETE SET NULL,
  snapshot_fencing_version integer NOT NULL DEFAULT 0,
  snapshotted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_profiles_app ON browser_profiles(app_id, updated_at);
