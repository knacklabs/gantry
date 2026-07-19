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

## Codex-verified inventory (2026-07-19 exploration; corrected from the draft)

ALREADY EXISTS (reuse, zero build):

- `runtime.artifact_store` settings block COMPLETE: driver local|s3, bucket,
  region, endpoint, force_path_style — parser (strict, S3-field validation),
  renderer, defaults all live (`runtime-settings-parser.ts:800`,
  `runtime-settings-artifact-store-renderer.ts`).
- Shared S3 client constructor passes endpoint + forcePathStyle
  (`adapters/artifacts/skills/s3-artifact-client.ts`) — MinIO ALREADY
  supported and rehearsed: `ops/docker/docker-compose.fleet.yml` runs
  `http://minio:9000` path-style with AWS*\* env creds; `entrypoint.sh` seeds
  bucket/region from `GANTRY_ARTIFACT*\*`.
- S3 stores for skills, toolchains, browser profiles + factory driver wiring
  for those three (`factory.ts:194-223`, `fleet-boot.ts:331`).
- Credential convention: AWS SDK default chain (IAM role / AWS\_\* env), NOT
  RuntimeSecretProvider — keep it.

MISSING (the actual gap list):

1. A bytes PORT: `LocalFileArtifactBytes` is a concrete class;
   `PostgresFileArtifactStore` constructor REQUIRES it
   (`file-artifact-repository.postgres.ts:56`) and hardcodes
   `storageType: 'local-filesystem'` (domain type permits only that value —
   `domain/file-artifacts/file-artifact.ts:5`).
2. `S3FileArtifactBytes` adapter (use the shared s3-artifact-client; objects
   `file-artifacts/<appId>/<contentHash>`; sha256 verify on read per the
   browser-profile pattern).
3. Driver switch for FILE artifacts in `createStorageRuntime()`
   (`factory.ts:159` constructs local unconditionally — the settings knob
   reaches skills/toolchains/browser-profiles but NOT file artifacts).
4. Presigned GET links: no presigner anywhere; needs
   `@aws-sdk/s3-request-presigner` (small, same SDK family) → Teams real
   delivery when driver=s3.
5. Host-side workspace registration (bypass the 2,000,000-char inline IPC
   cap — `ipc-file-artifact-handlers.ts:275`): host reads the workspace file
   via the new contained resolver and puts through the driver.
6. Terraform: add `file-artifacts/*` prefix + worker policy
   (`ops/terraform/modules/storage/main.tf` has only skills/toolchains/
   browser-profiles).
7. Send path currently buffers whole artifacts in memory
   (`send-message.ts:106`) — acceptable at the 25 MB cap; note, don't fix.

## Stages

1. Bytes port + `S3FileArtifactBytes` + factory driver switch + `storageType`
   domain value `'s3'` (repository stops hardcoding local).
2. Presigned-link Teams delivery when driver=s3 (local keeps the honest stub);
   expiry knob in the artifact_store block.
3. Host-side workspace registration through the driver (large-file unlock).
4. Terraform prefix/policy + MinIO integration leg in CI/docker smoke
   (compose fleet file already has the MinIO service to point at).

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
