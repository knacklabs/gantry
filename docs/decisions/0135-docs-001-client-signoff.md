---
status: accepted
confirmed_by: 'Yash'
date: 2026-07-27
---

# Decision 0135: DOCS-001 Client Signoff

## Context

The repository's current documentation contains stale implementation claims,
repository URLs, and broken relative links. The proposed change derives current
behavior from source code, executable registries, schemas, and tests, while
preserving historical records as evidence of earlier designs and reviews.

## Decision

Yash approves DOCS-001: create the static project explorer, source-derived
codebase guide, and reproduced issue report; refresh active documentation and
repository metadata; and repair broken documentation links without changing
their historical meaning.

## Consequences

- Current-behavior claims must be traceable to executable source or verification
  evidence.
- Historical prose remains historical; only its broken navigation is repaired.
- Known failures are reported honestly rather than waived as passing.
- The static explorer is treated as a user-facing deliverable and requires a
  functional desktop/mobile check.
