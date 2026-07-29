# Review Prompt — one autoreview run, three lenses

Review runs ONCE per task, after `verify.py` passes and the automated testing
artifact is recorded: a single autoreview run in a Codex session. Never review
inline in the coordinating session; never nest reviewers.

Loop discipline (carried over from the retired subagent panel): scope-freeze —
review the diff that exists, do not expand scope; verify findings against the
actual code before reporting; stop after two fix-verify cycles.

Procedure:

1. In Codex, run the autoreview skill over the current branch diff plus any
   files called out by the self-check.
2. Review through THREE lenses and emit one JSON per lens matching
   `.agents/schemas/review.json`, each with `"generated_by": "autoreview"`:
   - **quality** — correctness, regressions, maintainability where it affects
     defect risk, gaps in the implementer's tests, API/contract drift, and
     over-engineering: speculative abstractions, unused
     flexibility/configurability, code duplicating stdlib or platform
     features — EXCEPT structure the constitution mandates (modules, DTOs,
     the response envelope, provider pattern), which is never a finding.
     When the decomposition has `user_facing: true`, loading the
     `review-animations` skill as input to this lens is MANDATORY
     (easing/duration/spring choices, reduced-motion) — attest it in each
     artifact's `skills_used` list or the recorder refuses the artifact. It
     informs your findings; the artifact stays `generated_by: autoreview`.
   - **performance** — hot paths, algorithmic complexity, query fanout, I/O
     amplification, memory churn, concurrency bottlenecks; distinguish
     measured evidence from inference.
   - **security** — OWASP-style trust boundaries, authn/authz, secrets,
     injection, data exposure, unsafe defaults, abuse paths.
3. Emit findings STRUCTURED, not as prose strings: each entry in
   `blocking_findings`/`non_blocking_findings` is
   `{"category": "<kebab-case defect class>", "area": "<module/dir>",
   "summary": "<one sentence>"}`. The category is what lets
   `forge findings patterns` detect the same class recurring across tasks —
   the trigger for consolidation instead of a fourth patch (WORKFLOW.md
   "Recurring Findings"). Reuse category slugs you have used before; a
   renamed class is an undetected class.
4. Record each artifact:

```bash
python3 .agents/scripts/record_review_from_json.py --aspect <quality|performance|security> --input <json>
```

Afterwards — ONLY if the recorded decomposition has `user_facing: true` — run
the `functional-checker` subagent (`.agents/prompts/tester-functional.md`) and
record its result with `record_test_from_json.py --kind functional`.
