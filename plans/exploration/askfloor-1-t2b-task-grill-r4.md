# ASKFLOOR-1-T2b task-contract grill — round 4

Read-only cold-read review, no file edits, no writes. Follow `factory/prompts/griller.md --gate task` for the `ASKFLOOR-1-T2b` entry in `.factory/stories/ASKFLOOR-1/decomposition.json` and its saved task plan `.factory/stories/ASKFLOOR-1/task-plans/ASKFLOOR-1-T2b.md`. Inputs of record as in round 1 (`plans/exploration/askfloor-1-t2b-task-grill.md`); rounds 1–3 briefs and answers (`-r1-answer.md`, `-r2.md`, `-r2-answer.md`, `-r3.md`, `-r3-answer.md`).

Round 3 found three blockers; all folded:
1. AC4 and the resolver leaf name `result.artifact.virtualScope` / `result.artifact.virtualPath` (`domain/file-artifacts/file-artifact.ts:7-24`).
2. A non-absolute native destination is provider-relative and is resolved against the verified workspace root before boundary evaluation (`path.resolve(root, candidate)`); only a non-absolute ROOT fails closed; the native-write leaf covers absolute and relative keys and a `../x` escape.
3. The browser row states the real source forms: top-level `source` | `files` | `paths` (mutually exclusive) with `source.type` ∈ `bytes | path | artifact`; inline `payload.files` and `source.type === "bytes"` are LOW for both actions; the browser leaf covers `files`.
Also the clerical "source, 10" → 11.

Round 4 is a consistency and residual check: (a) every `path:line` citation in the ACs still resolves to the claimed fact; (b) consistency across the task plan, `plan_contracts`, `acceptance_criteria`, `required_tests` (fourteen — each a single `-t` selectable leaf whose title matches the AC it proves), `reviewer_focus`, `write_scope` (22) and `review_budget` (24/2000); (c) any remaining defect that would make the implementer build the wrong thing or make an AC unprovable.

Output: `CONTRACT SOUND` or a numbered list of blockers (what, where, why, minimal fix), then non-blocking notes.
