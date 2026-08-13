---
status: accepted
confirmed_by: "Ravi"
date: 2026-08-11
stories: [CAPFIX-1, JOBFLOW-1]
---

# Capability Command Templates Are Amendable Only by Human-Approved, Host-Compiled Amendment

## Context

Local-CLI capability `commandTemplates` are the authorization boundary (0120:
arity-exact, deliberately rigid). After the CLIRUN-1 cutover the KnackLabs job
produced zero leads on every run: the reviewed template `gog sheets get *`
(one argument) cannot fit the CLI's real contract `get <spreadsheetId>
<range>`. No surface could amend templates: the agent's definition-bearing
requests are rejected on catalog conflict (correct — anti-self-authorization),
no CLI or settings surface exists, and the only lever was raw SQL on
`tool_catalog`. Ravi rejected the SQL unblock (2026-08-11) and chose to leave
the job broken until the product path ships — fixing it from the card is
CAPFIX-1's live acceptance test.

## Decision

Decision 0125 supersedes agent authorship, the `request_access` amendment target, observed
argv in proposal identity, and best-effort post-approval recovery in this record. Template
amendment is a first-class, human-gated flow:

- The host compiles the only amendment proposal directly from verified mismatch context.
  The agent-authored `request_access` amendment target is removed. The compiler emits both
  full pinned-path templates for a flagged observation: the base positional form and the
  flagged variant with flag values wildcarded.
- A plain-language card renders in chat: ability-terms body from the
  capability's displayName/can/cannot, buttons "Approve fix"/"Deny"; no
  template strings, argv, ids, or hashes in the body — the technical delta
  rides the collapsed full-view. The deterministic classifier is tiered
  (amended by Ravi in chat, 2026-08-11, after review pressure surfaced the
  wildcard-as-operation-selector counterexample): added-trailing-input-only
  changes carry one soft factual sentence ("takes an extra input it couldn't
  before"); every other change leads with a stronger plain warning; only an
  exact-equivalent reshape is warning-free. Nothing under-warns.
- Human approval performs a transactional CAS amendment of
  `implementationBindings[*].commandTemplates` ONLY, with provenance and prior
  templates in a durable history row. The same transaction inserts a durable app-wide
  approval intent; recovery retries until every affected paused job is resumed or
  superseded (fix-and-continue, no re-ask).
- Deny is terminal and durable, deduped per (appId, capabilityId, canonical proposed
  templates) WITHIN a reviewed definition. Observed argv is stored only as one redacted
  evidence sample and is not part of identity. Within a reviewed definition,
  the stored reviewedSchemaHash scopes terminality, so a later catalog
  revision supersedes stale rows (pending and system-superseded bookkeeping
  alike) and reopens review — a human "no" binds the definition it judged,
  not every future one. (Refined during CAPFIX-1-1 review, 2026-08-12.)
- Executable identity (`executablePath`/`executableHash`/version) is immutable
  through this surface — binary changes remain a separate deliberate
  re-review.
- `tool_catalog` is the definition home; settings authority (0007/0025)
  governs capability SELECTION, not definitions. No settings mirroring in this
  flow.

## Consequences

- Template mismatches become one plain-language tap instead of operator SQL;
  the mismatch class (new CLIs, CLI version bumps, authoring mistakes) is
  permanently recoverable in-product.
- Agent self-amendment stays impossible; arity-exact matching (0120) is not
  relaxed — templates get richer, the matcher does not get looser.
- Approval-to-resume is durable under decision 0125; it is not a fire-and-forget recovery
  step.
- Rejected alternatives (do NOT re-propose): agent self-amendment under any
  condition; relaxing the matcher instead of fixing templates; operator SQL as
  the sanctioned path (Ravi rejected it explicitly).
