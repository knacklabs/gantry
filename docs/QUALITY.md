# QUALITY.md

## Quality Bar

Every change must pass these independent checks:
1. automated tests (written and run by the implementer)
2. deterministic verify
3. quality review
4. performance review
5. security review
6. functional check — only when the recorded decomposition has
   `user_facing: true`

Artifact shapes are NOT described here — each artifact's contract is its
schema under `.agents/schemas/`, enforced by the recorder that writes it.
Every payload carries `generated_by`, checked against the pins in
`harness.yaml` — and `skills_used`, checked against the schema's
`required_skills` for the feature type: user-facing testing artifacts must
attest `emil-design-eng` + `frontend-design`; user-facing review artifacts
must attest `review-animations`. No attestation, no artifact.

## Review — one autoreview run, three lenses

Contract: `.agents/prompts/reviewer.md`. A single autoreview run in Codex
(read-only toward product code) reviews the task diff through three lenses
and emits one artifact per lens, each matching `.agents/schemas/review.json`
with `generated_by: autoreview`:

- **quality** — correctness, regressions, maintainability-as-risk, test
  gaps, contract drift, over-engineering (constitution-mandated structure
  exempt); for user-facing diffs touching motion, the `review-animations`
  skill feeds this lens (harness.yaml `ui_guidance`)
- **performance** — hot paths, algorithmic complexity, query fanout, I/O
  amplification, memory churn, concurrency bottlenecks; measured evidence
  distinguished from inference
- **security** — OWASP-style trust boundaries, authn/authz, secrets,
  injection, data exposure, unsafe defaults, abuse paths

Never review inline in the coordinating session; never nest reviewers.

## Testing

### automated (the implementer's job)
- contract: `.agents/prompts/implementer.md` +
  `.agents/schemas/test-automated.json` (`generated_by: implementer`)
- the implementer adds or updates tests, runs scoped test commands, and
  records the artifact; autoreview's quality lens checks coverage honestly

### functional-checker (conditional)
- model: `gpt-5.5`, reasoning `high`, `workspace-write` when tooling needs
  artifacts, otherwise `read-only`
- contract: `.agents/prompts/tester-functional.md` +
  `.agents/schemas/test-functional.json` (`generated_by: functional-checker`)
- runs only when the decomposition records `user_facing: true`; the ship
  gate reads the flag, not anyone's judgment

## Artifact Contracts

Review artifacts live under `.factory/reviews/`; testing artifacts in
`.factory/tests.json` (`automated`, `functional` keys). Recorders refuse
payloads that do not match their schema.

PR-ready requires:
- no testing blockers
- no review blockers
- review scores >= 8 (all three lenses)
- functional score >= 8 when required (`user_facing: true`)
- evidence for acceptance criteria
