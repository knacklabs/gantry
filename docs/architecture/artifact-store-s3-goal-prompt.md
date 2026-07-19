# Goal: File-artifact bytes on S3/MinIO (+ Linux parity)

**Status: SCOPED 2026-07-19 (user requirement: "make it work in Linux, MinIO
and S3 support too"). Queue position: see goals-index.** Via
gantry-goal-pipeline with a Codex plan-validation pass before stage 1.

## Why

File-artifact BYTES are local-disk only (`adapters/artifacts/files/
local-file-artifact-bytes.ts`); metadata already lives in Postgres. Local-only
bytes block Linux/docker + fleet deployments (artifacts don't travel between
hosts) and self-hosted object storage. MinIO and AWS S3 share the S3 API — one
adapter covers both (endpoint + forcePathStyle config).

## Existing substrate (REUSE, do not rebuild)

- `@aws-sdk/client-s3` already a dependency.
- `s3-browser-profile-artifact-store.ts` — content-addressed S3 adapter
  pattern (hash verify, quarantine on mismatch) + terraform IAM in
  `ops/terraform/modules/storage/main.tf`.
- `RuntimeArtifactStoreDriver = 'local' | 's3'` already in
  `runtime-settings-types.ts`.
- `StoredFileArtifactBytes` port (storageRef/contentHash/sizeBytes) is
  backend-neutral already.

## Stages

1. **S3 bytes adapter**: `s3-file-artifact-bytes.ts` mirroring the
   local adapter's port, objects under `file-artifacts/<appId>/<contentHash>`,
   sha256 verified on read (browser-profile pattern). MinIO = same adapter with
   `endpoint` + `forcePathStyle: true`. Driver switch honors the existing
   settings knob; creds via runtime secrets (reuse the existing S3 client
   construction/env conventions from the browser-profile store).
2. **Send path**: outbound resolution streams from the driver (HEAD size gate
   before GET; the 25 MB cap enforced pre-download). Loud reasons unchanged.
3. **Teams real delivery via presigned links**: `GetObject` presigned URL
   (expiry knob) replaces the honest-degradation stub when the s3 driver is
   active — this retires the audit's "signed artifact links (future work)".
   Local driver keeps the stub.
4. **Big-file registration**: host-side register-from-workspace (the new
   workspace-direct resolution reads the file host-side) uploads straight to
   the driver — bypasses the ~1.5 MB base64 IPC write cap for workspace files.
   Agent-side base64 writes keep their cap.

## Linux parity note

Workspace-direct attachment containment is platform-split by design (macOS
`O_NOFOLLOW_ANY` atomic open / Linux `O_NOFOLLOW` + `/proc/self/fd`
descriptor re-resolution — shipped in the attachments cycle). Docker: `/proc`
is present by default; document that the runtime container must not mount
`/proc` restricted. Add a Linux CI leg (or docker-run smoke) exercising the
workspace containment tests + s3 adapter against MinIO
(`minio/minio` service container) so Linux behavior is proven, not assumed.

## Non-goals

- No agent-side direct-to-S3 uploads (would bypass the egress gateway and
  permission model; all object-store I/O stays host-side).
- No migration of browser-profile/toolchain stores (already done).
- No CDN/public buckets; presigned GETs only, private bucket.

## Verification

Unit: adapter contract tests against a stubbed S3 client; driver-switch
round-trip. Integration: MinIO container — put/get/hash-mismatch-quarantine,
presigned link fetch, oversize rejection. Existing attachment suites stay
green under both drivers.
