---
status: proposed
confirmed_by: ""
date: 2026-08-27
stories: [OPS-DR-1, PKG-1]
---

# Tagged releases carry upgrade and rollback guarantees (amends 0003)

## Context

Decision 0003 chose clean cuts over compatibility layers while the runtime was pre-release. Selling self-hosted deployments to clients means upgrades they run themselves; a failed upgrade with no restore path ends an engagement.

## Decision

From the first npm release tag, each release ships release notes, a pre-flight migration check, a pinned image digest, and a documented rollback to the previous digest with a tested backup/restore drill (OPS-DR-1). Clean cuts remain allowed between tags when the release notes name them and the migration check refuses an unsafe jump. 0003 stays in force for unreleased main.

## Consequences

- PKG-1 and OPS-DR-1 own the mechanics.
- Downgrade of the database is never promised; forward-fix plus restore is the path.
