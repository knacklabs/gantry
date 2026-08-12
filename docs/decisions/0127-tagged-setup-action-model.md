---
status: proposed
confirmed_by: ""
date: 2026-08-12
stories: [JOBFLOW-1]
---

# Tagged Setup Action Model [JOBFLOW-1]

Retires the nextAction:string + grantable:boolean blocker shape and the
regex/JSON-in-string interpretation layers (0115's grantable/
non-grantable card split becomes the action union).

## Context

Blocker actionability is inferred from a boolean plus string parsing:
executable authority is smuggled through nextAction JSON, a regex layer
reverse-engineers display labels, the storage parser silently drops
malformed blockers and dual-reads camelCase, and the two
JOB_SETUP_REQUIRED writers emit different shapes.

## Decision

JobSetupBlocker carries ONE tagged action union:
approve_grant{grant: PermissionAuthorityAddition — a narrow type covering
only validated allow-rule additions/replacements} |
fix_proposal{proposalId} | instruction{text}. Eligibility derives from
the variant; {instruction, grantable:true} is unrepresentable. Action
identity: approve_grant = hash(discriminant+subject); fix_proposal =
proposalId; instruction = hash(text). Blocker priority approve_grant >
fix_proposal > instruction, ties lexical. The storage parser is strict at
the boundary (specific remediation error; ready implies no blockers;
non-ready implies >=1 valid; unique identities; no partial arrays;
camelCase removed). ONE external event schema for both writers
(snake_case, full blocker objects with the action union); blocker-level
nextAction/grantable are REMOVED from the wire; top-level
setup.nextAction/health.nextAction/recovery.nextAction remain as derived
display strings from ONE shared formatter. The OpenAPI setup schema is
authored (typed), then SDK/CLI/MCP regenerate. Migration is offline and
total: every legacy non-ready row becomes the single typed instruction
action; fingerprint recomputed and notified_fingerprint set equal (no
renotification storm).

## Consequences

- No string parsing survives on any blocker path; the recovery-string
  parser and regex label layer are deleted.
- Wire/SDK/CLI/MCP consumers cut over atomically with the domain type.
- Rejected (do not re-propose): the full PermissionApprovalUpdate as the
  grant payload (permits removals/mode changes durable approval never
  accepts); runtime reconstruction of malformed rows to instruction;
  readiness re-evaluation inside the migration.
Full contracts: plans/JOBFLOW-contract-appendix.md (S2b).
