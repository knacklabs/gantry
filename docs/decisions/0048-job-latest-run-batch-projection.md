---
status: proposed
confirmed_by: ""
date: 2026-07-24
---

# Job Latest-Run Batch Projection

## Context

`GET /v1/jobs` fans out one `listJobRuns(job.id, 1)` query per listed job via
`Promise.all` (up to 500 concurrent queries)
(`apps/core/src/control/server/routes/jobs.ts:394`,
`apps/core/src/application/jobs/job-visibility-metadata.ts:294`). The audit's
simplification #4 prescribes one batch projection.

## Decision

Add one repository-owned batch method `listLatestJobRunsByJobIds(jobIds)` on
the canonical Postgres job repository using a `DISTINCT ON (job_id)`
projection ordered by job id, `started_at DESC NULLS LAST`, `created_at DESC`;
`buildJobListVisibilityMetadata` consumes its result map synchronously.

## Consequences

- A 500-job listing issues one latest-run query; ordering, null-`started_at`
  handling, health/staleness, error summaries, and the response schema are
  unchanged (equivalence-tested against the per-job path).
- Rejected: a concurrency limit over the existing N+1 — bounds the burst but
  keeps N round trips.
