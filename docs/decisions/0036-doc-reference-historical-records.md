---
status: proposed
confirmed_by: ""
date: 2026-07-22
---

# Doc Reference Historical Records

## Context

`check_doc_references` (scripts/architecture_rules.py) validates every doc
reference but has no exemption mechanism. Dated audit/review/validation
records reference then-current paths; when machinery moves (e.g. the 0002
`.codex` rehoming), those records rot into permanent dangling-reference
noise. De-linkifying refs inside the records would mutate immutable history
and recur for every future dated audit. Grilled at the PAY-1 plan gate;
client ruled archival classification is not an exception (2026-07-22).

## Decision

The checker gains an explicit opt-in freeze marker —
`<!-- doc-references: frozen <ISO-date> (decision 0036) -->` — that scopes a
document out of dangling-reference checking ONLY. It is permanent (archival
classification, not a time-bounded exception) and allowed ONLY on dated
historical records; the checker also skips `<placeholder>` template tokens.

## Consequences

- Initial stamped set: pr237-final-review, pr237-validation,
  ponytail-audit-2026-07-14, ponytail-audit-2026-07-16,
  media-render-plan-validation, permission-durable-storage-plan-validation,
  agent-e2e-plan-validation-round2, outbound-attachments-audit-2026-07-19,
  permission-floor-and-promotion-goal-prompt (superseded), plus the
  banner'd codex-harness and codex-self-improvement histories if needed.
- Stamping any NEW doc requires updating this record in the same change;
  live docs stay fully checked; all other gates still apply to frozen docs.
- The `frozenDocs` allowlist in `scripts/architecture-map.json` is the machine enforcement point for this rule.
- Checker changes land with tests in scripts/tests/test_check_architecture.py.
- Amendment (signal S-0001-5b3c, 2026-07-22): missing references whose path
  starts with `plans/` are skipped — that namespace is runtime ledgers that
  materialize on first forge use (assumptions.md, team.json, …); requiring
  their pre-existence would force creating empty ledgers by hand.
