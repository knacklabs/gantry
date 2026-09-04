# Review Prompt — one autoreview run, three lenses

Review runs ONCE per task, after `verify.py` passes and the automated testing
artifact is recorded, and before `task pr-ready`. The orchestrator releases it
with **`./forge review <task-id>`** (decisions 0011, 0049): that command runs
the autoreview skill with Codex as its engine — once per lens, in a clean
worktree pinned at the task tip, over the whole task diff from its recorded
base — watches it, and records the three artifacts as the task's proof. NEVER
hand the review to a nested Codex companion job (that re-triggers the same
skill one indirection deeper and the companion write-guard refuses it), and
never hand-write findings inline.

Loop discipline (carried over from the retired subagent panel): scope-freeze —
review the diff that exists, do not expand scope; verify findings against the
actual code before reporting; stop after two fix-verify cycles.

Review depth: run the helper at **`--max-priority P2`**, not the P0-only
default. P0-only ships correct-but-unmaintainable code — it hides structure,
validation-depth, and clarity findings that are exactly what keeps a growing
codebase healthy. P0/P1 findings are blocking; P2 findings are recorded as
`non_blocking_findings` and MUST be resolved or explicitly deferred (with a
reason) before the task ships, not silently dropped.

Procedure:

1. `./forge review <task-id>` does the run: it mints the branch review run
   (`review-brief --all`, which every recorded artifact is bound to), composes
   `.factory/review-briefs/<task-id>.<lens>.md` per lens from the task's plan
   contracts, reviewer focus, and the lens definition below, and runs the skill
   in **branch mode from the task's recorded base** — the whole task diff
   (`--mode commit --commit HEAD` would review only the LAST commit of a
   multi-commit task) — at `--max-priority P2`, with Codex as the engine. The
   run is pinned in a clean detached worktree because the skill refuses to
   finish if the reviewed tree changes mid-run and the main tree is where the
   harness keeps writing. Findings on harness bookkeeping paths (`.factory/`,
   `plans/`, `docs/decisions/`) are dropped. The quality artifact's
   `contract_verdicts` are parsed from the reviewer's
   `VERDICT <contract-id>: implemented|partial|missing — <evidence>` lines; a
   contract the reviewer did not verdict is recorded as `partial` (fail-closed)
   so it surfaces as a blocking finding rather than passing silently. Verdicts
   are required for the reviewed task's contracts and those of tasks already
   done; tasks that have not started are not verdicted (0049).
2. Review through THREE lenses and emit one JSON per lens matching
   `factory/schemas/review.json`, each with `"generated_by": "autoreview"`:
   - **quality** — correctness, regressions, gaps in the implementer's tests,
     API/contract drift, and **maintainability** — not only where it affects
     defect risk. **Approved-deliverable presence and reachability — check this
     FIRST, before judging the code that IS present.** Cross-check the task's
     `acceptance_criteria` AND the approved task-plan's concrete deliverables
     against the ACTUAL diff. Every deliverable a criterion or the plan names — a
     guard/middleware, an endpoint or route, a migration, a config wiring, a CI
     job, a decorator, a port/adapter — must be genuinely IMPLEMENTED and
     REACHABLE (registered in the module/app, actually invoked — not merely
     defined in a file nothing imports). A promised deliverable that is ABSENT, or
     present but unreachable, is a BLOCKING finding under a stable
     `missing-deliverable` category — even when everything that IS present is
     clean and the build passes. This is the check that catches an implementation
     silently dropping an approved requirement that lived in plan prose or an
     acceptance criterion rather than a formal `plan_contract`/`contract_verdict`:
     a tidy PARTIAL implementation must never pass as complete. When the task
     declares `plan_contracts`, this presence audit is in addition to (not a
     substitute for) the per-contract `contract_verdicts`. Flag single-responsibility violations and poor file/folder
     organisation: a service that mixes types + validation + data access +
     mapping + orchestration in one file, thin/partial validation of required
     inputs, uncontrolled string literals where an enum/constant belongs,
     generic `Error` where a domain error type belongs, support/declaration
     files that cram unrelated concerns together (e.g. typed enums + primitive
     constants + DI tokens in one file), and a large module dumped flat with no
     coherent directory grouping by responsibility and concern. This
     organisation check is technology-AGNOSTIC — flag INCOHERENCE against the
     organisation the task's `reviewer_focus` calls for, never a specific
     mandated layout; cluster it under a stable `code-organization` category so
     `forge findings patterns` sees it recur. **Structure-for-growth
     is NOT over-engineering:** organising distinct, concrete responsibilities
     in foundational/shared infrastructure that is known to grow (a seam many
     future tasks route through) is correct design — do not wave it through as
     "over-engineering". Reserve the over-engineering finding for *speculative*
     abstraction: flexibility/configurability nothing uses, indirection for
     futures nobody has asked for, one-file-per-interface, abstract classes with
     a single trivial implementation, constants for values used once, or code
     duplicating stdlib/platform features. Constitution-mandated structure
     (modules, DTOs, the response envelope, provider pattern) is never a finding.
     **Ponytail conformance — the minimal-diff discipline is enforced at REVIEW,
     not only at write.** The implementer is bound to the ponytail ladder
     (necessity/YAGNI → reuse what exists → stdlib → native platform feature →
     an already-installed dependency → one line → minimum viable code); flag a
     diff that breaks it — a new dependency where the stdlib or an installed one
     suffices, a reimplementation of an existing helper, speculative flexibility,
     or a sprawling change where a surgical one would do — as an
     `over-engineering` finding. Lazy is NOT negligent: a diff that drops
     required input/trust-boundary validation, error handling, security, or
     accessibility to look smaller is the OPPOSITE finding — a blocking gap,
     never waved through as "minimal".
     **Conversely, the constitution's coding standards are LAW, and code that
     VIOLATES them IS a finding** under a stable `constitution-conformance`
     category. Read `constitution/README.md` and the references its index maps to
     this diff, then flag deviations: an HTTP endpoint missing a typed request OR
     RESPONSE DTO (`pnp-api-standards`, `pnp-swagger-api-documentation-standards`),
     wrong file suffixes or a module layout that ignores
     `pnp-coding-standards-modular-monolith`/`03`, string literals where a typed
     enum/constant belongs, missing structured logging on security-relevant events
     (`05`/`06`), generic `Error` where domain exception handling is required
     (`07`), an integration that bypasses the provider/port pattern (`08`,
     `pnp-provider-pattern-for-integration`), or schema work ignoring
     `pnp-database-standards`. Judge conformance to the constitution and the task's
     `reviewer_focus` citations — the constitution, not your taste, is the standard
     (do not impose an invented layout beyond it). This holds whichever engine runs
     the lens and in any environment: `constitution/` is on disk, always readable.
     **Cyclomatic complexity — assess EVERY review, no exceptions.** Measure the
     branching complexity of each function/method the diff adds or changes; any
     whose control flow is excessively tangled (roughly >10 independent paths —
     deep nesting, long if/elif/switch chains, compound boolean conditions) is a
     BLOCKING finding under a stable `cyclomatic-complexity` category, naming the
     decomposition it needs (guard clauses, extracted helpers, table/polymorphic
     dispatch). Flag genuinely knotted control flow, never mere file or line
     count — constitution-mandated structure is never the target, and a run of
     simple sequential statements is not complexity.
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
python3 factory/scripts/record_review_from_json.py --aspect <quality|performance|security> --input <json>
```

Afterwards — ONLY if the recorded decomposition has `user_facing: true` — run
the `functional-checker` subagent (`factory/prompts/tester-functional.md`) and
record its result with `record_test_from_json.py --kind functional`.
