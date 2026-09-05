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
schema under `factory/schemas/`, enforced by the recorder that writes it.
Every payload carries `generated_by`, checked against the pins in
`harness.yaml` — and `skills_used`, checked against the schema's
`required_skills` for the feature type: user-facing testing artifacts must
attest `emil-design-eng` + `frontend-design`; user-facing review artifacts
must attest `review-animations`. No attestation, no artifact.

## Review — one autoreview run, three lenses

Contract: `factory/prompts/reviewer.md`. A single autoreview run in Codex
(read-only toward product code) reviews the task diff through three lenses
and emits one artifact per lens, each matching `factory/schemas/review.json`
with `generated_by: autoreview`:

- **quality** — correctness, regressions, maintainability-as-risk, test
  gaps, contract drift, over-engineering (constitution-mandated structure
  exempt), and **cyclomatic complexity** — assessed on EVERY review, with
  excessively tangled control flow a blocking `cyclomatic-complexity`
  finding; for user-facing diffs touching motion, the `review-animations`
  skill feeds this lens (harness.yaml `ui_guidance`)
- **performance** — hot paths, algorithmic complexity, query fanout, I/O
  amplification, memory churn, concurrency bottlenecks; measured evidence
  distinguished from inference
- **security** — OWASP-style trust boundaries, authn/authz, secrets,
  injection, data exposure, unsafe defaults, abuse paths

Never review inline in the coordinating session; never nest reviewers.

## Review findings are not a menu

A finding the review just raised is work, and work goes to Codex. Delegate the
fix and re-review; loop until clean. Do not put it to the human as a choice
between fixing now, shipping and deferring, or fixing it yourself — that asks
them to arbitrate something already settled.

- **Blocking findings** cannot be deferred or shipped past: readiness refuses
  them, so two of those three options never existed.
- **Non-blocking findings** default to the same fix loop. Defer one only when it
  is genuinely outside the task's scope, with a reason and a revisit trigger.
- **Host-side fixing** is the single exception, and only when the defect cannot
  be reproduced or fixed inside the Codex sandbox. Open a ledgered degraded
  window and state why.

## Testing

### automated (the implementer's job)
- contract: `factory/prompts/implementer.md` +
  `factory/schemas/test-automated.json` (`generated_by: implementer`)
- the implementer adds or updates tests, runs scoped test commands, and
  records the artifact; autoreview's quality lens checks coverage honestly

### functional-checker (conditional)
- model: `gpt-5.5`, reasoning `high`, `workspace-write` when tooling needs
  artifacts, otherwise `read-only`
- contract: `factory/prompts/tester-functional.md` +
  `factory/schemas/test-functional.json` (`generated_by: functional-checker`)
- runs only when the decomposition records `user_facing: true`; the ship
  gate reads the flag, not anyone's judgment

## Artifact Contracts

Proof is stored under the task that produced it:

    .factory/stories/<key>/tasks/<id>/verify.json
    .factory/stories/<key>/tasks/<id>/tests.json      (automated, functional)
    .factory/stories/<key>/tasks/<id>/reviews/{quality,performance,security}.json

Recorders resolve the owning task from the worktree's run pointer, so running
them inside a task worktree records task-scoped proof without being told. A
story-level run (no `task_id`) still records story-scoped proof, and readers
fall back to it — work recorded before task scoping is never stranded.

This used to be one set of artifacts per STORY, rewritten by each task in
turn: a story's review described whichever task ran last, and a task PR could
pass on another task's evidence. Recorders refuse payloads that do not match
their schema.

A TASK is PR-ready when its own proof is complete and clean:
- no testing blockers
- no review blockers
- review scores >= 8 (all three lenses)
- functional score >= 8 when the TASK is `user_facing: true`
- evidence for acceptance criteria

A STORY ships on the sum of its tasks: every task marker on the trunk, every
task's proof clean, every plan contract verified by the task that owns it, and
the recorded outcome. Closeout runs no second verify, no second three-lens
review and no second functional check — those re-review reviewed code, and one
late fix in the last task would invalidate every earlier task's evidence.
