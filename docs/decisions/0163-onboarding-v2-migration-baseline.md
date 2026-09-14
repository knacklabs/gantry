---
status: accepted
confirmed_by: "Ashirwad Shetye"
date: 2026-09-14
stories: [ONBOARDING-V2-1]
---

# V2 onboarding uses one pre-release schema baseline

## Context

Gantry has not been deployed, so the V2 onboarding archive must not create a
long-lived migration history merely to preserve intermediate local work. The
archive currently contains generated snapshots that obscure the small durable
state the feature actually needs: resumable onboarding and verification
records. Its migration-only delta contains two SQL files and two generated
snapshots totalling 39,156 changed lines.

## Decision

Adopt the V2 onboarding schema as one canonical pre-release migration from the
current `origin/main` schema. Generate its Drizzle metadata through the
repository's normal generator; do not transplant archival migration snapshots
or handwritten metadata.

## Consequences

The task must prove the resulting migration chain and disposable-Postgres
onboarding lifecycle. The V2 archive remains an immutable source reference,
but its generated migration history is not part of the adopted product delta.
