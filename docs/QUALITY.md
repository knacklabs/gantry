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

Contract: `factory/prompts/reviewer.md`. One autoreview run in Codex reviews
the task diff through three lenses in one pass, read-only inside the review
worktree so it reads the code it judges (0076). A diff too big for one prompt
runs as parallel groups: one three-lens run per group over its files with the
whole task tree readable, a refused group retried alone with the cause in its
brief, the results merged into one record with the worst verdict per contract
winning; lock and generated files are not sent (0078). The recorder validates
`factory/schemas/review-set.json`,
publishes one immutable generation containing the exact raw helper bytes and
three `factory/schemas/review.json` lens records, then replaces the task's
`selected.json` pointer last. Combined and rejection records use
`generated_by: autoreview`; sealed-only legacy migration uses
`generated_by: upgrade` without invented helper provenance:

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

The run is the task's ONLY review: with no blocking (P0/P1) finding it
stamps the stage — bound to the reviewed tree — and `stage done` and
`task pr-ready` seal on that stamp; non-blocking findings are recorded
follow-ups and never lower the score below the seal floor. The brief carries
what is settled (the story plan's decisions and rulings, the contracts of
tasks already sealed, the lessons in force); a finding that contradicts
settled text is rejected on the record with `forge review <id> --reject`,
which requires a citation that resolves to a decision, a plan section or a
sealed contract, records its deterministic lesson before selection, and
publishes an immutable successor to the selected combined or rejection
generation. Sealing validates and commits the complete generation-and-lesson
lineage. A diagnostic `--lens` run
cannot select proof, stamp a stage, or revoke an earlier selection.

## Review findings are not a menu

Blocking findings go back to Codex as one fix batch, followed by fresh proof
and review of the changed code. Do not ask the human to choose whether to fix
a blocker; readiness already requires it. Apply the bounded recovery rule
below when a retry makes no progress.

- **Blocking findings** cannot be deferred or shipped past: readiness refuses
  them, so two of those three options never existed.
- **Non-blocking findings** are recorded follow-ups. Resolve them within the
  current fix batch or explicitly defer them with a reason and revisit trigger.
  Do not start another full review solely to remove an unchanged, recorded
  non-blocking follow-up; it does not block the seal.
- **Host-side fixing** is the single exception, and only when the defect cannot
  be reproduced or fixed inside the Codex sandbox. Open a ledgered degraded
  window and state why. A window that closes with at most five files, all
  inside the task's write scope, is accepted by `stage done` as the stage's
  write launch and recorded on the stage.

## Bounded recovery

Apply this rule in every phase, including hooks, planning, approval, tests,
review, task closure and PR/CI. After the same action fails twice with the
same inputs and cause, stop launching model retries. Keep the failure and
current artifacts; identify the cause with the smallest reproducible check,
fix it, and show that check passing before retrying the expensive action.
A pending external job is a wait, not a failure: inspect its identity and
status with backoff, and resume only the job that is actually still live.
When a worker finishes or is blocked, it returns control to its coordinator;
it must not take over orchestration to satisfy a story-level Stop hook.

Keep the approved contract stable while fixing implementation details inside
its scope. Record outcomes, scope or acceptance changes through the existing
amendment and approval route. A new patch hash or a verification log is not
a new contract. Keep one current plan and report; archive superseded versions
and reference them rather than appending their full contents. Reviews still
receive the complete current approved plan and task proof.

For PR/CI recovery, inspect the exact failing command or check before retrying.
Do not rerun completed checks, reseal unchanged proof, or push an empty commit
to restart CI. Change the failing input or recover the external dependency
first. If progress requires a human decision or unavailable external access,
report that concrete blocker; do not manufacture another review cycle.

## Testing

### automated (the implementer's job)
- contract: `factory/prompts/implementer.md` +
  `factory/schemas/test-automated.json` (`generated_by: implementer`)
- the implementer adds or updates tests, runs scoped test commands, and
  records the artifact; autoreview's quality lens checks coverage honestly

### functional-checker (conditional)
- model: `gpt-5.6-sol`, reasoning `high`, `workspace-write` when tooling needs
  artifacts, otherwise `read-only`
- contract: `factory/prompts/tester-functional.md` +
  `factory/schemas/test-functional.json` (`generated_by: functional-checker`)
- runs only when the decomposition records `user_facing: true`; the ship
  gate reads the flag, not anyone's judgment

## Artifact Contracts

Proof is stored under the task that produced it:

    .factory/stories/<key>/tasks/<id>/verify.json
    .factory/stories/<key>/tasks/<id>/tests.json      (automated, functional)
    .factory/stories/<key>/tasks/<id>/reviews/selected.json
    .factory/stories/<key>/tasks/<id>/reviews/generations/<sha256>.json

Complete review recording requires `--set --task <id>` and never falls back to
story-level or fixed lens files. Fixed `{quality,performance,security}.json`
files are diagnostic or one-time migration inputs only.

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
