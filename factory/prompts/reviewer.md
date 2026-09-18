# Review Prompt — one Codex run, three lenses

Review runs ONCE per task, after `verify.py` passes and the automated testing
artifact is recorded, and before `task pr-ready`. `./forge task close <task-id>`
releases it (`./forge review <task-id>` alone does the same; decisions 0011,
0049, 0069): one autoreview call in Codex over the whole task diff from its
recorded base, in a clean worktree pinned at the task tip, judging quality,
performance and security in ONE pass, watched, then recorded as ONE immutable
generation holding three lens records behind one selected pointer. Never one
run per lens, never recorded by hand: `forge review` runs the recorder itself.
NEVER hand the review to a nested Codex companion job (that re-triggers the
same skill one indirection deeper and the companion write-guard refuses it),
and never hand-write findings inline.

The reviewer reads the tree it judges (0076): Codex runs read-only inside the
review worktree, so a verdict or a finding on code the diff does not show is
read, not guessed. A diff too big for one prompt runs as parallel groups: one
three-lens Codex run per group over its files with the whole task tree
readable, a refused group retried alone with the cause in its brief, the
results merged into one record with the worst verdict per contract winning;
lock and generated files are not sent (0078). Contract verdicts are finding
records titled `[quality] VERDICT <contract-id>: implemented|partial|missing`
(0077).

Formal review uses `gpt-5.6-sol` at `high` reasoning. Route fixes back to the
active `gpt-5.6-sol`/medium implementer and reuse that agent across review loops.

Loop discipline: scope-freeze — review the diff that exists, do not expand
scope; verify findings against the actual code before reporting. Recovery is
bounded by `docs/QUALITY.md` "Bounded recovery": after the same action fails
twice with the same inputs and cause, stop launching model retries and find
the cause first. The host triages every blocking finding before a fix round
(`./forge review <id> --triage`, 0075): open the cited line and its callee,
prove it real or not with a file:line, list every instance; never relay a
finding unread, never make findings a menu for the human.

Review depth: the helper runs at **`--max-priority P3`**, the complete
three-lens depth `forge review` enforces. P0/P1 findings block the task; P2/P3
findings are recorded as `non_blocking_findings` and MUST be resolved or
explicitly deferred (with a reason) before the task ships — never silently
dropped, and never by themselves the reason for another review.

Procedure:

1. `./forge review <task-id>` does the run: it mints the branch review run
   (`review-brief --all`, which the recorded generation is bound to), composes
   `.factory/review-briefs/<task-id>.combined.md` from the task's plan
   contracts, reviewer focus and the three lens definitions below, and runs
   the skill in **branch mode from the task's recorded base** — the whole task
   diff (`--mode commit --commit HEAD` would review only the LAST commit of a
   multi-commit task) — at `--max-priority P3`, with Codex as the engine. The
   run is pinned in a clean detached worktree because the skill refuses to
   finish if the reviewed tree changes mid-run and the main tree is where the
   harness keeps writing. Harness bookkeeping (`.factory/`, `plans/`,
   `docs/decisions/`) and lock/generated files are put back to the base in
   the review tip, so the bundle is the product delta only; findings on
   bookkeeping paths are dropped. The quality record's `contract_verdicts`
   are lifted from the reviewer's verdict records; a contract with no verdict
   is recorded `partial` (fail-closed) so it surfaces as a blocking finding
   rather than passing silently. Verdicts are required for the reviewed
   task's contracts and those of tasks already done; tasks that have not
   started are not verdicted (0049).
2. Review through THREE lenses in that one pass; the recorder projects the one
   result into three `factory/schemas/review.json` lens records, each with
   `"generated_by": "autoreview"`:
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
4. `forge review` records the generation itself
   (`record_review_from_json.py --set`), replaces the task's `selected.json`
   pointer last, and stamps the stage when nothing blocks. The per-aspect
   recorder (`--aspect <lens>`) serves only a diagnostic `--lens` run, which
   never selects proof.

Afterwards — ONLY if the recorded decomposition has `user_facing: true` — run
the Sol/high `functional-checker` subagent (`factory/prompts/tester-functional.md`) and
record its result with `record_test_from_json.py --kind functional`.
